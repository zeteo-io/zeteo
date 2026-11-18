// @module-tag int
// @module-tag platform
import { GoogleKeyRejectedError } from "../../../../../utils/errors.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  SOURCES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const checkServiceAccountKey = vi.fn(async (_key: unknown) => undefined);
vi.mock("../../../../../google/handler.js", () => ({
  googleClient: vi.fn(),
  sheetsApi: {},
  checkServiceAccountKey: (key: unknown) => checkServiceAccountKey(key),
}));

const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIsecretsecret\n-----END PRIVATE KEY-----\n";
const EMAIL = "sa@proj.iam.gserviceaccount.com";
const goodKey = () => ({
  type: "service_account",
  client_email: EMAIL,
  private_key: PRIVATE_KEY,
  project_id: "proj",
});

describe("/v1/connections/google", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const admin = () => tokenFor({ permissions: [SOURCES_WRITE] });
  const call = (method: string, token: string | null, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/connections/google`, token, body);
  const clear = () => prisma.connection.deleteMany({});

  beforeAll(async () => {
    app = await startV1Routes();
  });
  beforeEach(async () => {
    checkServiceAccountKey.mockClear();
    await clear();
  });
  afterAll(async () => {
    await clear();
    await app.close();
  });

  it("GET is 404 google_not_configured before a key is set", async () => {
    const res = await call("GET", admin());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("google_not_configured");
  });

  it("PUT stores the key sealed and answers only the email", async () => {
    const userId = randomUUID();
    const res = await call(
      "PUT",
      tokenFor({ permissions: [SOURCES_WRITE], userId }),
      {
        service_account_key: goodKey(),
      }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: "google",
      service_account_email: EMAIL,
      updated_at: expect.any(String),
      updated_by: userId,
    });
    expect(JSON.stringify(res.body)).not.toContain("private_key");
    expect(JSON.stringify(res.body)).not.toContain("secretsecret");
    const row = await prisma.connection.findUniqueOrThrow({
      where: { provider: "google" },
    });
    const stored = JSON.stringify(row.sealedSettings);
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain("secretsecret");
    const got = await call("GET", admin());
    expect(got.status).toBe(200);
    expect(got.body.service_account_email).toBe(EMAIL);
  });

  it("PUT accepts the key as a JSON string", async () => {
    const res = await call("PUT", admin(), {
      service_account_key: JSON.stringify(goodKey()),
    });
    expect(res.status).toBe(200);
    expect(res.body.service_account_email).toBe(EMAIL);
  });

  it("PUT refuses a key Google rejects with 422 google_key_rejected and stores nothing", async () => {
    checkServiceAccountKey.mockRejectedValueOnce(new GoogleKeyRejectedError());
    const res = await call("PUT", admin(), { service_account_key: goodKey() });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("google_key_rejected");
    expect(JSON.stringify(res.body)).not.toContain("secretsecret");
    expect(await prisma.connection.count()).toBe(0);
  });

  it.each([
    ["a wrong type", { ...goodKey(), type: "authorized_user" }],
    ["a key that is not a PEM", { ...goodKey(), private_key: "nope" }],
    ["no email", { type: "service_account", private_key: PRIVATE_KEY }],
  ])("PUT refuses %s with 400", async (_name, key) => {
    const res = await call("PUT", admin(), { service_account_key: key });
    expect(res.status).toBe(400);
    expect(checkServiceAccountKey).not.toHaveBeenCalled();
  });

  it("PUT refuses a string that is not JSON with 400, without echoing it", async () => {
    const res = await call("PUT", admin(), {
      service_account_key: "{ secretsecret",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("secretsecret");
  });

  it("PUT needs zeteo.sources.write; GET works with only zeteo.uploads.write", async () => {
    const uploader = tokenFor({ permissions: [UPLOADS_WRITE] });
    const put = await call("PUT", uploader, { service_account_key: goodKey() });
    expect(put.status).toBe(403);
    await call("PUT", admin(), { service_account_key: goodKey() });
    const get = await call("GET", uploader);
    expect(get.status).toBe(200);
    expect(get.body.service_account_email).toBe(EMAIL);
    expect((await call("GET", tokenFor({ permissions: [] }))).status).toBe(403);
    expect((await call("GET", null)).status).toBe(401);
  });

  it("PUT is audited as zeteo.connection.updated without the key", async () => {
    await call("PUT", admin(), { service_account_key: goodKey() });
    const rows = await prisma.$queryRaw<
      Array<{ payload: Record<string, unknown> }>
    >`
      SELECT payload FROM "core"."core_outbox"
      WHERE payload->'metadata'->>'event' = 'zeteo.connection.updated'
      ORDER BY created_at DESC LIMIT 1`;
    expect(rows[0]!.payload).toMatchObject({
      action: "UPDATE",
      metadata: {
        event: "zeteo.connection.updated",
        provider: "google",
        service_account_email: EMAIL,
      },
    });
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("secretsecret");
  });
});
