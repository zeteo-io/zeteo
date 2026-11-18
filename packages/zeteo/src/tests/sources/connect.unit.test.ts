// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it } from "vitest";
import env from "../../env.js";
import {
  CHECK_POOL_SIZE,
  uploadsReaderSettings,
  poolSizeFor,
} from "../../sources/connect.js";

describe("poolSizeFor", () => {
  it.each([
    [5, 2, 9],
    [1, 1, 4],
    [50, 10, 62],
  ])(
    "opens two connections more than %s queries and %s exports at once: %s",
    (queryConcurrency, exportConcurrency, size) => {
      expect(poolSizeFor({ queryConcurrency, exportConcurrency })).toBe(size);
    }
  );

  it("gives a login check's own connection one connection", () => {
    expect(CHECK_POOL_SIZE).toBe(1);
  });
});

describe("uploadsReaderSettings", () => {
  const original = env.UPLOADS_READER_URL;
  afterEach(() => {
    env.UPLOADS_READER_URL = original;
  });

  it("reads the reader's settings from UPLOADS_READER_URL, TLS off by default", () => {
    env.UPLOADS_READER_URL =
      "postgresql://uploads%20reader:p%40ss@db.internal:6543/zeteo%5Fdb";
    expect(uploadsReaderSettings()).toEqual({
      host: "db.internal",
      port: 6543,
      database: "zeteo_db",
      user: "uploads reader",
      password: "p@ss",
      tls: "off",
    });
  });

  it("defaults the port to 5432 and unwraps an IPv6 host", () => {
    env.UPLOADS_READER_URL = "postgresql://r:p@[::1]/zeteo";
    expect(uploadsReaderSettings()).toMatchObject({ host: "::1", port: 5432 });
  });

  it.each([
    ["disable", "off"],
    ["require", "require"],
    ["verify-full", "verify"],
  ])("maps sslmode=%s to tls %s", (sslmode, tls) => {
    env.UPLOADS_READER_URL = `postgresql://r:p@h/zeteo?sslmode=${sslmode}`;
    expect(uploadsReaderSettings().tls).toBe(tls);
  });

  it.each(["prefer", "verify-ca", "allow", ""])(
    "refuses sslmode=%s",
    (sslmode) => {
      env.UPLOADS_READER_URL = `postgresql://r:p@h/zeteo?sslmode=${sslmode}`;
      expect(() => uploadsReaderSettings()).toThrow(
        expect.objectContaining({
          statusCode: 503,
          code: "uploads_misconfigured",
          problem: expect.stringMatching(/sslmode/),
        })
      );
    }
  );

  it("throws 404 uploads_not_configured when Uploads are off", () => {
    env.UPLOADS_READER_URL = undefined;
    expect(() => uploadsReaderSettings()).toThrow(
      expect.objectContaining({
        statusCode: 404,
        code: "uploads_not_configured",
      })
    );
  });
});
