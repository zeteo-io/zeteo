// @module-tag unit
// @module-tag platform
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  postgresSettingsSchema,
  toPgConfig,
} from "../../../adapters/postgres/settings.js";

const settings = postgresSettingsSchema.parse({
  host: "db.example.com",
  database: "sales",
  user: "reader",
  password: "s3cret",
  ca: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
});

const options = { connectTimeoutMs: 4000, poolSize: 3, queryTimeoutMs: 7000 };

describe("postgres settings", () => {
  it("refuses an unknown key", () => {
    const parsed = postgresSettingsSchema.safeParse({
      ...settings,
      sslmode: "disable",
    });
    expect(parsed.success).toBe(false);
  });

  it.each(["host", "database", "user", "password"])(
    "refuses an empty %s",
    (key) => {
      expect(
        postgresSettingsSchema.safeParse({ ...settings, [key]: "" }).success
      ).toBe(false);
    }
  );

  it.each([0, 65536, 1.5])("refuses the port %s", (port) => {
    expect(
      postgresSettingsSchema.safeParse({ ...settings, port }).success
    ).toBe(false);
  });

  it("defaults the port and verifies TLS", () => {
    expect(settings.port).toBe(5432);
    expect(settings.tls).toBe("verify");
  });

  it("redacts the password and the CA", () => {
    const redacted = postgresAdapter.redact(settings);
    expect(redacted).not.toHaveProperty("password");
    expect(redacted).not.toHaveProperty("ca");
    expect(redacted).toMatchObject({
      host: "db.example.com",
      port: 5432,
      database: "sales",
      user: "reader",
      tls: "verify",
    });
  });

  it("names its host for the network rules", () => {
    expect(postgresAdapter.hostOf(settings)).toBe("db.example.com");
    expect(postgresAdapter.type).toBe("postgres");
  });
});

describe("toPgConfig", () => {
  const target = {
    host: "db.example.com",
    address: "10.1.2.3",
    family: 4,
  } as const;

  it("dials the checked address with discrete fields", () => {
    const config = toPgConfig(settings, target, options);
    expect(config).toMatchObject({
      host: "10.1.2.3",
      port: 5432,
      database: "sales",
      user: "reader",
      application_name: "zeteo",
      connectionTimeoutMillis: 4000,
      max: 3,
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("verify: checks the certificate against the typed name and the given CA", () => {
    const { ssl } = toPgConfig(settings, target, options);
    expect(ssl).toEqual({
      rejectUnauthorized: true,
      servername: "db.example.com",
      ca: settings.ca,
    });
  });

  it("verify: uses the system CAs when none is given", () => {
    const { ssl } = toPgConfig({ ...settings, ca: undefined }, target, options);
    expect(ssl).toEqual({
      rejectUnauthorized: true,
      servername: "db.example.com",
    });
  });

  it("require: encrypts without verifying the certificate", () => {
    const { ssl } = toPgConfig(
      { ...settings, tls: "require" },
      target,
      options
    );
    expect(ssl).toMatchObject({
      rejectUnauthorized: false,
      servername: "db.example.com",
    });
  });

  it("off: no TLS", () => {
    expect(toPgConfig({ ...settings, tls: "off" }, target, options).ssl).toBe(
      false
    );
  });

  it("sends no server name for an IP literal", () => {
    const literal = {
      host: "10.1.2.3",
      address: "10.1.2.3",
      family: 4,
    } as const;
    const { ssl } = toPgConfig(settings, literal, options);
    expect(ssl).not.toHaveProperty("servername");
  });
});

describe("toPgConfig against the environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  const target = {
    host: "db.example.com",
    address: "10.1.2.3",
    family: 4,
  } as const;

  it("hands the password over as a function, so an empty value cannot fall back", async () => {
    const config = toPgConfig(settings, target, options);
    expect(typeof config.password).toBe("function");
    expect(await (config.password as () => string)()).toBe("s3cret");
  });

  it("derives every connection parameter from the settings, whatever PG* variables are set", () => {
    for (const [key, value] of Object.entries({
      PGPASSWORD: "env-password",
      PGUSER: "env-user",
      PGDATABASE: "env-database",
      PGHOST: "env-host",
      PGPORT: "6543",
      PGSSLMODE: "disable",
      PGOPTIONS: "-c search_path=evil",
      PGAPPNAME: "env-app",
      PGREPLICATION: "database",
      PGSSLNEGOTIATION: "direct",
      PGCONNECT_TIMEOUT: "99",
    })) {
      vi.stubEnv(key, value);
    }
    const client = new pg.Client(toPgConfig(settings, target, options));
    const params = (
      client as unknown as { connectionParameters: Record<string, unknown> }
    ).connectionParameters;
    expect(params).toMatchObject({
      user: "reader",
      database: "sales",
      host: "10.1.2.3",
      port: 5432,
      options: "-c default_transaction_read_only=on",
      application_name: "zeteo",
      replication: "false",
      sslnegotiation: "postgres",
      connect_timeout: 4,
      statement_timeout: 7000,
      query_timeout: 7000,
    });
    expect(params.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(typeof params.password).toBe("function");
    expect((params.password as () => string)()).toBe("s3cret");
  });

  it("limits every query on both sides", () => {
    const config = toPgConfig(settings, target, options);
    expect(config.query_timeout).toBe(7000);
    expect(config.statement_timeout).toBe(7000);
  });
});
