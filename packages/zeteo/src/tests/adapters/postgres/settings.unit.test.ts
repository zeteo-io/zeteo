// @module-tag unit
// @module-tag platform
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { describe, expect, it } from "vitest";
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

const options = { connectTimeoutMs: 4000, poolSize: 3 };

describe("postgres settings", () => {
  it("refuses an unknown key", () => {
    const parsed = postgresSettingsSchema.safeParse({
      ...settings,
      sslmode: "disable",
    });
    expect(parsed.success).toBe(false);
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
      password: "s3cret",
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
