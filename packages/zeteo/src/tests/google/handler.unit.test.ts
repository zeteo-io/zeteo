// @module-tag unit
// @module-tag platform
import { beforeEach, describe, expect, it, vi } from "vitest";

const addTemplateClient = vi.fn(async () => undefined);
const removeTemplateClient = vi.fn(async () => undefined);
const getSpreadsheet = vi.fn();
const readGoogleConnection = vi.fn();
const readGoogleStamp = vi.fn();
const start = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
const getLoadedClients = vi.fn(() => [] as Array<{ name: string }>);

vi.mock("@dianemo/core", () => ({
  default: class {
    use() {
      return { google: { getSpreadsheet } };
    }
    addTemplateClient = addTemplateClient;
    removeTemplateClient = removeTemplateClient;
    start = start;
    stop = stop;
    getLoadedClients = getLoadedClients;
  },
  buildClientName: (_: string, o: { instanceId: string }) =>
    `google:_:${o.instanceId}`,
}));
vi.mock("@dianemo/backend-redis", () => ({ redisBackend: () => ({}) }));
vi.mock("@dianemo/plugin-google", () => ({ default: {} }));
vi.mock("../../utils/redis.js", () => ({ redis: {} }));
vi.mock("../../google/connectionStore.js", () => ({
  readGoogleConnection,
  readGoogleStamp,
}));

const { googleClient, checkServiceAccountKey, stopGoogleHandler } =
  await import("../../google/handler.js");

const connection = (updatedAt: Date) => ({
  serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  updatedAt,
  updatedBy: "u",
});

const failure = (code: string) => Object.assign(new Error("x"), { code });

/** The connection as stored at `updatedAt`: the stamp and the full row agree. */
const setConnection = (updatedAt: Date | null) => {
  readGoogleStamp.mockResolvedValue(updatedAt);
  readGoogleConnection.mockResolvedValue(updatedAt && connection(updatedAt));
};

describe("googleClient", () => {
  beforeEach(async () => {
    await stopGoogleHandler();
    vi.clearAllMocks();
  });

  it("re-registers the template after the connection changes, and not before", async () => {
    setConnection(new Date(1000));
    const first = await googleClient();
    await googleClient();
    expect(addTemplateClient).toHaveBeenCalledTimes(1);
    expect(readGoogleConnection).toHaveBeenCalledTimes(1);
    setConnection(new Date(2000));
    const second = await googleClient();
    expect(addTemplateClient).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(addTemplateClient).toHaveBeenLastCalledWith(
      "google",
      expect.objectContaining({
        serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      })
    );
  });

  it("registers once for calls that arrive together", async () => {
    setConnection(new Date(1000));
    await Promise.all([googleClient(), googleClient(), googleClient()]);
    expect(addTemplateClient).toHaveBeenCalledTimes(1);
  });

  it("does not register again for an older stamp", async () => {
    setConnection(new Date(2000));
    await googleClient();
    readGoogleStamp.mockResolvedValue(new Date(1000));
    await googleClient();
    expect(addTemplateClient).toHaveBeenCalledTimes(1);
  });

  it("throws google_not_configured without a connection", async () => {
    setConnection(null);
    await expect(googleClient()).rejects.toMatchObject({
      statusCode: 404,
      code: "google_not_configured",
    });
  });

  it("sweeps leftover key-check clients when it starts, and no other client", async () => {
    getLoadedClients.mockReturnValueOnce([
      { name: "google:_:validate-abc" },
      { name: "google:_:main" },
    ]);
    setConnection(new Date(1000));
    await googleClient();
    expect(removeTemplateClient).toHaveBeenCalledTimes(1);
    expect(removeTemplateClient).toHaveBeenCalledWith("google", "validate-abc");
  });
});

describe("stopGoogleHandler", () => {
  beforeEach(async () => {
    await stopGoogleHandler();
    vi.clearAllMocks();
  });

  it("is a no-op when the handler never started", async () => {
    await expect(stopGoogleHandler()).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops a started handler once and lets the next use start a new one", async () => {
    setConnection(new Date(1000));
    await googleClient();
    await stopGoogleHandler();
    await stopGoogleHandler();
    expect(stop).toHaveBeenCalledTimes(1);
    await googleClient();
    expect(start).toHaveBeenCalledTimes(2);
    expect(addTemplateClient).toHaveBeenCalledTimes(2);
  });
});

describe("checkServiceAccountKey", () => {
  const key = {
    client_email: "sa@proj.iam.gserviceaccount.com",
    private_key: "k",
  };
  beforeEach(async () => {
    await stopGoogleHandler();
    vi.clearAllMocks();
  });

  it("accepts a key whose sign-in succeeded and whose probe Google answered 403/404", async () => {
    getSpreadsheet.mockRejectedValue(failure("GGL_0009"));
    await expect(checkServiceAccountKey(key)).resolves.toBeUndefined();
    expect(removeTemplateClient).toHaveBeenCalledTimes(1);
  });

  it("rejects a key Google's sign-in refused", async () => {
    getSpreadsheet.mockRejectedValue(failure("GGL_0013"));
    await expect(checkServiceAccountKey(key)).rejects.toMatchObject({
      statusCode: 422,
      code: "google_key_rejected",
    });
    expect(removeTemplateClient).toHaveBeenCalledTimes(1);
  });

  it("rejects a key the plugin refuses at registration", async () => {
    addTemplateClient.mockRejectedValueOnce(new Error("bad pem"));
    await expect(checkServiceAccountKey(key)).rejects.toMatchObject({
      code: "google_key_rejected",
    });
  });

  it("still answers when the probe client cannot be removed", async () => {
    getSpreadsheet.mockRejectedValue(failure("GGL_0009"));
    removeTemplateClient.mockRejectedValueOnce(new Error("redis down"));
    await expect(checkServiceAccountKey(key)).resolves.toBeUndefined();
  });

  it("answers 502 google_unavailable for any other failure", async () => {
    getSpreadsheet.mockRejectedValue(failure("GGL_0012"));
    await expect(checkServiceAccountKey(key)).rejects.toMatchObject({
      statusCode: 502,
      code: "google_unavailable",
    });
  });
});
