// @module-tag unit
// @module-tag platform
import { beforeEach, describe, expect, it, vi } from "vitest";

const addTemplateClient = vi.fn(async () => undefined);
const removeTemplateClient = vi.fn(async () => undefined);
const getSpreadsheet = vi.fn();
const readGoogleConnection = vi.fn();

vi.mock("@dianemo/core", () => ({
  default: class {
    use() {
      return { google: { getSpreadsheet } };
    }
    addTemplateClient = addTemplateClient;
    removeTemplateClient = removeTemplateClient;
  },
  buildClientName: (_: string, o: { instanceId: string }) =>
    `google:_:${o.instanceId}`,
}));
vi.mock("@dianemo/backend-redis", () => ({ redisBackend: () => ({}) }));
vi.mock("@dianemo/plugin-google", () => ({ default: {} }));
vi.mock("../../utils/redis.js", () => ({ redis: {} }));
vi.mock("../../google/connection.js", () => ({ readGoogleConnection }));

const { googleClient, checkServiceAccountKey } =
  await import("../../google/handler.js");

const connection = (updatedAt: Date) => ({
  serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  updatedAt,
  updatedBy: "u",
});

const failure = (code: string) => Object.assign(new Error("x"), { code });

describe("googleClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-registers the template after the connection changes, and not before", async () => {
    readGoogleConnection.mockResolvedValue(connection(new Date(1000)));
    const first = await googleClient();
    await googleClient();
    expect(addTemplateClient).toHaveBeenCalledTimes(1);
    readGoogleConnection.mockResolvedValue(connection(new Date(2000)));
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

  it("throws google_not_configured without a connection", async () => {
    readGoogleConnection.mockResolvedValue(null);
    await expect(googleClient()).rejects.toMatchObject({
      statusCode: 404,
      code: "google_not_configured",
    });
  });
});

describe("checkServiceAccountKey", () => {
  const key = {
    client_email: "sa@proj.iam.gserviceaccount.com",
    private_key: "k",
  };
  beforeEach(() => vi.clearAllMocks());

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

  it("answers 502 google_unavailable for any other failure", async () => {
    getSpreadsheet.mockRejectedValue(failure("GGL_0012"));
    await expect(checkServiceAccountKey(key)).rejects.toMatchObject({
      statusCode: 502,
      code: "google_unavailable",
    });
  });
});
