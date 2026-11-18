// @module-tag int
// @module-tag platform
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../google/handler.js", () => ({
  googleClient: vi.fn(),
  sheetsApi: {},
  checkServiceAccountKey: vi.fn(async () => undefined),
}));

const { putGoogleConnection, readGoogleConnection } =
  await import("../../google/connection.js");

const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIsecretsecret\n-----END PRIVATE KEY-----\n";
const caller = () => ({
  userId: randomUUID(),
  organizationId: null,
  permissions: [],
  isServiceAccount: false,
});

describe("the Google connection", () => {
  const clear = () => prisma.connection.deleteMany({});
  beforeAll(initializeTereo);
  beforeEach(clear);
  afterAll(async () => {
    await clear();
    await stopTereo();
  });

  it("reads null before a key is set", async () => {
    expect(await readGoogleConnection()).toBeNull();
  });

  it("stores the key sealed and reads it back", async () => {
    const who = caller();
    const view = await putGoogleConnection(who, {
      type: "service_account",
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY,
    });
    expect(view).toEqual({
      provider: "google",
      service_account_email: "sa@proj.iam.gserviceaccount.com",
      updated_at: expect.any(String),
      updated_by: who.userId,
    });
    const row = await prisma.connection.findUniqueOrThrow({
      where: { provider: "google" },
    });
    const stored = JSON.stringify(row.sealedSettings);
    expect(stored).not.toContain("secretsecret");
    expect(await readGoogleConnection()).toMatchObject({
      serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
      privateKey: PRIVATE_KEY,
      updatedBy: who.userId,
    });
  });
});
