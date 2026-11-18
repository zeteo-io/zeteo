// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it } from "vitest";
import env from "../../env.js";
import {
  CHECK_POOL_SIZE,
  fileReaderSettings,
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

describe("fileReaderSettings", () => {
  const original = env.FILE_SOURCES_READER_URL;
  afterEach(() => {
    env.FILE_SOURCES_READER_URL = original;
  });

  it("reads the reader's settings from FILE_SOURCES_READER_URL, TLS off by default", () => {
    env.FILE_SOURCES_READER_URL =
      "postgresql://files%20reader:p%40ss@db.internal:6543/zeteo%5Fdb";
    expect(fileReaderSettings()).toEqual({
      host: "db.internal",
      port: 6543,
      database: "zeteo_db",
      user: "files reader",
      password: "p@ss",
      tls: "off",
    });
  });

  it("defaults the port to 5432 and unwraps an IPv6 host", () => {
    env.FILE_SOURCES_READER_URL = "postgresql://r:p@[::1]/zeteo";
    expect(fileReaderSettings()).toMatchObject({ host: "::1", port: 5432 });
  });

  it.each([
    ["disable", "off"],
    ["require", "require"],
    ["verify-full", "verify"],
  ])("maps sslmode=%s to tls %s", (sslmode, tls) => {
    env.FILE_SOURCES_READER_URL = `postgresql://r:p@h/zeteo?sslmode=${sslmode}`;
    expect(fileReaderSettings().tls).toBe(tls);
  });

  it.each(["prefer", "verify-ca", "allow", ""])(
    "refuses sslmode=%s",
    (sslmode) => {
      env.FILE_SOURCES_READER_URL = `postgresql://r:p@h/zeteo?sslmode=${sslmode}`;
      expect(() => fileReaderSettings()).toThrow(/sslmode/);
    }
  );

  it("throws when File Sources are off", () => {
    env.FILE_SOURCES_READER_URL = undefined;
    expect(() => fileReaderSettings()).toThrow(/not configured/);
  });
});
