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

  it.each([
    ["USER_QUERY_CONCURRENCY", 5, 100],
    ["USER_EXPORT_CONCURRENCY", 1, 10],
  ] as const)(
    "defaults %s to %s and takes 1 to %s only",
    (name, fallback, max) => {
      expect(parseEnv(base)[name]).toBe(fallback);
      expect(parseEnv({ ...base, [name]: "1" })[name]).toBe(1);
      expect(parseEnv({ ...base, [name]: String(max) })[name]).toBe(max);
      for (const bad of ["0", String(max + 1), "1.5", "abc"]) {
        expect(() => parseEnv({ ...base, [name]: bad })).toThrow(
          new RegExp(name)
        );
      }
    }
  );

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

  it("turns MCP off by default and reads the connector clients as a list", () => {
    expect(parseEnv(base).MCP_ALLOWED_CLIENTS).toEqual([]);
    expect(
      parseEnv({ ...base, MCP_ALLOWED_CLIENTS: " claude-connector, ,chatgpt " })
        .MCP_ALLOWED_CLIENTS
    ).toEqual(["claude-connector", "chatgpt"]);
  });

  it("reads MCP_ALLOWED_ORIGINS as origins, empty by default, and refuses anything else", () => {
    expect(parseEnv(base).MCP_ALLOWED_ORIGINS).toEqual([]);
    expect(
      parseEnv({
        ...base,
        MCP_ALLOWED_ORIGINS: "https://claude.ai,http://localhost:3000",
      }).MCP_ALLOWED_ORIGINS
    ).toEqual(["https://claude.ai", "http://localhost:3000"]);
    for (const bad of [
      "claude.ai",
      "https://claude.ai/path",
      "ftp://x",
      "http://*",
      "https://*",
      "https://*.example.com",
    ]) {
      expect(() => parseEnv({ ...base, MCP_ALLOWED_ORIGINS: bad })).toThrow(
        /MCP_ALLOWED_ORIGINS/
      );
    }
  });

  it("defaults MCP_RATE_LIMIT_PER_MINUTE to 120 and takes 1 to 10000 only", () => {
    expect(parseEnv(base).MCP_RATE_LIMIT_PER_MINUTE).toBe(120);
    expect(
      parseEnv({ ...base, MCP_RATE_LIMIT_PER_MINUTE: "10000" })
        .MCP_RATE_LIMIT_PER_MINUTE
    ).toBe(10_000);
    for (const bad of ["0", "10001", "1.5"]) {
      expect(() =>
        parseEnv({ ...base, MCP_RATE_LIMIT_PER_MINUTE: bad })
      ).toThrow(/MCP_RATE_LIMIT_PER_MINUTE/);
    }
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

describe("admin UI settings", () => {
  const prod = {
    ...base,
    NODE_ENV: "production",
    TEREO_TEST_MODE: "false",
    PUBLIC_URL: "https://zeteo.example.com",
    ZETEO_MASTER_KEY: Buffer.alloc(32, 9).toString("base64url"),
    TEREO_URL: "https://tereo.example.com",
    TEREO_CLIENT_ID: "zeteo",
    TEREO_CLIENT_SECRET: "secret",
    REQUEST_HANDLER_KEY: "x".repeat(40),
  };

  it("defaults UI_TEREO_URL to TEREO_URL", () => {
    expect(
      parseEnv({ ...base, UI_CLIENT_ID: "ui", TEREO_URL: "http://t:4001/" })
        .UI_TEREO_URL
    ).toBe("http://t:4001");
    expect(
      parseEnv({
        ...base,
        UI_CLIENT_ID: "ui",
        TEREO_URL: "http://t:4001",
        UI_TEREO_URL: "https://public.example.com/",
      }).UI_TEREO_URL
    ).toBe("https://public.example.com");
  });

  it("refuses an http UI_TEREO_URL in production, and takes https", () => {
    expect(() =>
      parseEnv({
        ...prod,
        UI_CLIENT_ID: "ui",
        UI_TEREO_URL: "http://x.example.com",
      })
    ).toThrow(/UI_TEREO_URL/);
    expect(
      parseEnv({
        ...prod,
        UI_CLIENT_ID: "ui",
        UI_TEREO_URL: "https://x.example.com",
      }).UI_TEREO_URL
    ).toBe("https://x.example.com");
  });

  it("needs a Tereo URL once UI_CLIENT_ID is set", () => {
    expect(() => parseEnv({ ...base, UI_CLIENT_ID: "ui" })).toThrow(
      /UI_TEREO_URL/
    );
    expect(parseEnv(base).UI_CLIENT_ID).toBeUndefined();
  });

  it("takes a UI_CLIENT_ID of 1 to 64 characters", () => {
    const url = { ...base, UI_TEREO_URL: "https://t.example.com" };
    expect(
      parseEnv({ ...url, UI_CLIENT_ID: "a".repeat(64) }).UI_CLIENT_ID
    ).toHaveLength(64);
    expect(() => parseEnv({ ...url, UI_CLIENT_ID: "a".repeat(65) })).toThrow(
      /UI_CLIENT_ID/
    );
  });

  it("resolves UI_DIST_PATH from the package root: a default, an absolute path as is", () => {
    expect(parseEnv(base).UI_DIST_PATH).toMatch(/packages\/zeteo-ui\/dist$/);
    expect(parseEnv({ ...base, UI_DIST_PATH: "/srv/ui" }).UI_DIST_PATH).toBe(
      "/srv/ui"
    );
    expect(parseEnv({ ...base, UI_DIST_PATH: "web" }).UI_DIST_PATH).toMatch(
      /packages\/zeteo\/web$/
    );
  });

  it("refuses an http TEREO_URL in production when it becomes the UI's", () => {
    expect(() =>
      parseEnv({
        ...prod,
        TEREO_URL: "http://tereo.internal",
        UI_CLIENT_ID: "ui",
      })
    ).toThrow(/UI_TEREO_URL/);
  });

  it("names UI_TEREO_URL when it is malformed in production", () => {
    expect(() =>
      parseEnv({ ...prod, UI_CLIENT_ID: "ui", UI_TEREO_URL: "not a url" })
    ).toThrow(/UI_TEREO_URL/);
  });

  it.each([
    "ftp://core.example.com",
    "https://user:pass@core.example.com",
    "https://core.example.com/?a=1",
    "https://core.example.com/#frag",
  ])("refuses UI_TEREO_URL %s", (value) => {
    expect(() =>
      parseEnv({ ...base, UI_CLIENT_ID: "ui", UI_TEREO_URL: value })
    ).toThrow(/UI_TEREO_URL/);
  });

  it("keeps a path on UI_TEREO_URL, minus the trailing slash", () => {
    expect(
      parseEnv({
        ...base,
        UI_CLIENT_ID: "ui",
        UI_TEREO_URL: "https://core.example.com/base/",
      }).UI_TEREO_URL
    ).toBe("https://core.example.com/base");
  });

  const unsafe = [
    "ftp://core.example.com",
    "https://user:pass@core.example.com",
    "https://core.example.com/?token=1",
    "https://core.example.com/#frag",
  ];

  it.each(unsafe)(
    "refuses an inherited TEREO_URL %s once UI_CLIENT_ID is set",
    (value) => {
      expect(() =>
        parseEnv({ ...base, UI_CLIENT_ID: "ui", TEREO_URL: value })
      ).toThrow(/TEREO_URL is published to browsers/);
    }
  );

  it.each(unsafe)(
    "still takes TEREO_URL %s with no UI variable set",
    (value) => {
      expect(parseEnv({ ...base, TEREO_URL: value }).TEREO_URL).toBe(value);
    }
  );

  it("does not check TEREO_URL when UI_TEREO_URL supplies the value", () => {
    expect(
      parseEnv({
        ...base,
        UI_CLIENT_ID: "ui",
        TEREO_URL: "https://user:pass@tereo.internal",
        UI_TEREO_URL: "https://core.example.com",
      }).UI_TEREO_URL
    ).toBe("https://core.example.com");
  });
});
