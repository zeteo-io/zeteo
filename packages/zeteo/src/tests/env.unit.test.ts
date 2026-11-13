// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { parseEnv } from "../env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://x/y",
  REDIS_URL: "redis://x",
  TEREO_TEST_MODE: "true",
};

describe("env schema", () => {
  it("takes the default of a variable set to the empty string", () => {
    expect(parseEnv({ ...base, PORT: "", LOG_LEVEL: "" })).toMatchObject({
      PORT: 4201,
      LOG_LEVEL: "info",
    });
  });

  it("defaults QUERY_RUNS_RETENTION_DAYS to 90 and takes 0 to 3650 only", () => {
    expect(parseEnv(base).QUERY_RUNS_RETENTION_DAYS).toBe(90);
    expect(
      parseEnv({ ...base, QUERY_RUNS_RETENTION_DAYS: "0" })
        .QUERY_RUNS_RETENTION_DAYS
    ).toBe(0);
    expect(() =>
      parseEnv({ ...base, QUERY_RUNS_RETENTION_DAYS: "3651" })
    ).toThrow(/QUERY_RUNS_RETENTION_DAYS/);
    expect(() =>
      parseEnv({ ...base, QUERY_RUNS_RETENTION_DAYS: "-1" })
    ).toThrow(/QUERY_RUNS_RETENTION_DAYS/);
  });

  it("refuses a PORT that is not a number", () => {
    expect(() => parseEnv({ ...base, PORT: "abc" })).toThrow(/PORT/);
  });

  it("defaults CORS_ALLOWED_ORIGINS to the origin of PUBLIC_URL", () => {
    expect(
      parseEnv({ ...base, PUBLIC_URL: "https://zeteo.example.com/app/" })
    ).toMatchObject({
      PUBLIC_URL: "https://zeteo.example.com/app",
      CORS_ALLOWED_ORIGINS: ["https://zeteo.example.com"],
    });
  });

  it("parses SOURCE_ALLOWED_HOSTS, empty by default, and refuses a bad entry", () => {
    expect(parseEnv(base).SOURCE_ALLOWED_HOSTS).toEqual([]);
    expect(
      parseEnv({ ...base, SOURCE_ALLOWED_HOSTS: "db.internal,10.0.0.0/8" })
        .SOURCE_ALLOWED_HOSTS
    ).toHaveLength(2);
    expect(() =>
      parseEnv({ ...base, SOURCE_ALLOWED_HOSTS: "http://x" })
    ).toThrow(/SOURCE_ALLOWED_HOSTS.*http:\/\/x/);
  });

  it("refuses a lock timeout not below the transaction timeout", () => {
    expect(() =>
      parseEnv({
        ...base,
        DB_TRANSACTION_TIMEOUT_MS: "3000",
        DB_LOCK_TIMEOUT_MS: "3000",
      })
    ).toThrow(/DB_LOCK_TIMEOUT_MS/);
  });

  it("requires PUBLIC_URL, and refuses TRUST_PROXY=true, in production", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(
      /PUBLIC_URL/
    );
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        PUBLIC_URL: "https://zeteo.example.com",
        TRUST_PROXY: "true",
      })
    ).toThrow(/TRUST_PROXY/);
  });

  it("requires the tereo connection unless test mode is on", () => {
    const { TEREO_TEST_MODE: _testMode, ...bare } = base;
    expect(() => parseEnv(bare)).toThrow(/TEREO_URL/);
    expect(
      parseEnv({
        ...bare,
        TEREO_URL: "http://core.example.com",
        TEREO_CLIENT_ID: "zeteo",
        TEREO_CLIENT_SECRET: "secret",
        REQUEST_HANDLER_KEY: "k".repeat(32),
      })
    ).toMatchObject({ TEREO_TEST_MODE: false });
  });

  it("refuses TEREO_TEST_MODE in production", () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        PUBLIC_URL: "https://zeteo.example.com",
      })
    ).toThrow(/TEREO_TEST_MODE/);
  });

  describe("ZETEO_MASTER_KEY", () => {
    const key = Buffer.alloc(32, 9).toString("base64url");
    const dev = { ...base, NODE_ENV: "development" };

    it("is required outside NODE_ENV=test", () => {
      expect(() => parseEnv({ ...dev, TEREO_TEST_MODE: "true" })).toThrow(
        /ZETEO_MASTER_KEY/
      );
      expect(parseEnv({ ...dev, ZETEO_MASTER_KEY: key }).ZETEO_MASTER_KEY).toBe(
        key
      );
      expect(parseEnv({ ...base, NODE_ENV: "test" }).ZETEO_MASTER_KEY).toBe(
        undefined
      );
    });

    it("refuses the published development key in production, without echoing it", () => {
      const published = Buffer.alloc(32, 7).toString("base64url");
      const production = {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://x/y",
        REDIS_URL: "redis://x",
        PUBLIC_URL: "https://zeteo.example.com",
        TEREO_URL: "http://core.example.com",
        TEREO_CLIENT_ID: "zeteo",
        TEREO_CLIENT_SECRET: "secret",
        REQUEST_HANDLER_KEY: "k".repeat(32),
      };
      let message = "";
      try {
        parseEnv({ ...production, ZETEO_MASTER_KEY: published });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/ZETEO_MASTER_KEY/);
      expect(message).not.toContain(published);
      expect(
        parseEnv({ ...production, ZETEO_MASTER_KEY: key }).ZETEO_MASTER_KEY
      ).toBe(key);
      expect(
        parseEnv({ ...dev, ZETEO_MASTER_KEY: published }).ZETEO_MASTER_KEY
      ).toBe(published);
    });

    it.each([
      ["too short", Buffer.alloc(16, 9).toString("base64url")],
      ["too long", Buffer.alloc(33, 9).toString("base64url")],
      ["standard base64", Buffer.alloc(32, 0xfb).toString("base64")],
      ["not base64url", "!".repeat(43)],
    ])("refuses a key that is %s without echoing it", (_name, value) => {
      let message = "";
      try {
        parseEnv({ ...dev, ZETEO_MASTER_KEY: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/ZETEO_MASTER_KEY/);
      expect(message).not.toContain(value);
    });
  });
});
