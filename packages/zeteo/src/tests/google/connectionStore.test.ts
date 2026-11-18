// @module-tag int
// @module-tag platform
import { readGoogleConnection } from "../../google/connectionStore.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import { randomUUID } from "crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIsecretsecret\n-----END PRIVATE KEY-----\n";

const store = (sealedSettings: object) =>
  prisma.connection.create({
    data: { provider: "google", sealedSettings, updatedBy: randomUUID() },
  });

describe("readGoogleConnection", () => {
  const clear = () => prisma.connection.deleteMany({});
  beforeEach(clear);
  afterEach(() => vi.restoreAllMocks());
  afterAll(clear);

  it("a key that no longer opens (the master key rotated) is google_not_configured, logged without key material", async () => {
    const warn = vi.spyOn(logger, "warn");
    // Sealed for another id: opening it fails as with another master key.
    await store({
      sealed: sealSettings(
        {
          serviceAccountEmail: "sa@proj.iam.gserviceaccount.com",
          privateKey: PRIVATE_KEY,
        },
        "connection:other"
      ),
      service_account_email: "sa@proj.iam.gserviceaccount.com",
    });
    await expect(readGoogleConnection()).rejects.toMatchObject({
      statusCode: 404,
      code: "google_not_configured",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE KEY|secret/);
  });

  it("a row of the wrong shape is google_not_configured", async () => {
    await store({ something: "else" });
    await expect(readGoogleConnection()).rejects.toMatchObject({
      code: "google_not_configured",
    });
  });
});
