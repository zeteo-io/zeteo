// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { parseEnv } from "../env.js";

const base = {
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
});
