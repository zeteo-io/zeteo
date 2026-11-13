// @module-tag unit
// @module-tag platform
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import { type AddressInfo, createServer, type Server } from "node:net";
import {
  azureSqlSettingsSchema,
  toMssqlConfig,
} from "../../../adapters/azure-sql/settings.js";

const settings = azureSqlSettingsSchema.parse({
  host: "sales.database.windows.net",
  database: "sales",
  user: "reader",
  password: "s3cret",
});

const options = { connectTimeoutMs: 4000, poolSize: 3, queryTimeoutMs: 7000 };

const target = {
  host: "sales.database.windows.net",
  address: "10.1.2.3",
  family: 4,
} as const;

describe("azure-sql settings", () => {
  it("refuses an unknown key", () => {
    for (const extra of [
      { encrypt: false },
      { instanceName: "SQLEXPRESS" },
      { domain: "CORP" },
      { authentication: { type: "ntlm" } },
    ]) {
      expect(
        azureSqlSettingsSchema.safeParse({ ...settings, ...extra }).success
      ).toBe(false);
    }
  });

  it.each(["host", "database", "user", "password"])(
    "refuses an empty %s",
    (key) => {
      expect(
        azureSqlSettingsSchema.safeParse({ ...settings, [key]: "" }).success
      ).toBe(false);
    }
  );

  it.each([0, 65536, 1.5])("refuses the port %s", (port) => {
    expect(
      azureSqlSettingsSchema.safeParse({ ...settings, port }).success
    ).toBe(false);
  });

  it("refuses a named instance, which the driver would look up over UDP", () => {
    expect(
      azureSqlSettingsSchema.safeParse({
        ...settings,
        host: "db.example.com\\SQLEXPRESS",
      }).success
    ).toBe(false);
  });

  it("refuses a TLS mode other than verify or trust-server-certificate", () => {
    for (const tls of ["off", "require", "strict"]) {
      expect(
        azureSqlSettingsSchema.safeParse({ ...settings, tls }).success
      ).toBe(false);
    }
  });

  it("defaults the port and verifies TLS", () => {
    expect(settings.port).toBe(1433);
    expect(settings.tls).toBe("verify");
  });

  it("redacts the password", () => {
    const redacted = azureSqlAdapter.redact(settings);
    expect(redacted).toEqual({
      host: "sales.database.windows.net",
      port: 1433,
      database: "sales",
      user: "reader",
      tls: "verify",
    });
  });

  it("names its host for the network rules and its type", () => {
    expect(azureSqlAdapter.hostOf(settings)).toBe("sales.database.windows.net");
    expect(azureSqlAdapter.type).toBe("azure-sql");
    expect(azureSqlAdapter.language.id).toBe("sql");
  });
});

describe("toMssqlConfig", () => {
  it("names the server by the checked hostname, with discrete fields and limits", () => {
    const config = toMssqlConfig(settings, target, options);
    expect(config).toMatchObject({
      server: "sales.database.windows.net",
      port: 1433,
      database: "sales",
      user: "reader",
      password: "s3cret",
      connectionTimeout: 4000,
      requestTimeout: 7000,
      pool: { max: 3, min: 0, acquireTimeoutMillis: 4000 },
    });
    expect(config).not.toHaveProperty("connectionString");
    expect(config).not.toHaveProperty("domain");
    expect(config.options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false,
      appName: "zeteo",
      port: 1433,
      useUTC: true,
      cancelTimeout: 2000,
      enableAnsiNull: true,
      enableAnsiWarnings: true,
      enableArithAbort: true,
    });
    expect(config.options).not.toHaveProperty("instanceName");
    expect(typeof config.options?.connector).toBe("function");
  });

  it("verify: checks the certificate", () => {
    expect(toMssqlConfig(settings, target, options).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false,
    });
  });

  it("trust-server-certificate: encrypts without checking the certificate", () => {
    expect(
      toMssqlConfig(
        { ...settings, tls: "trust-server-certificate" },
        target,
        options
      ).options
    ).toMatchObject({ encrypt: true, trustServerCertificate: true });
  });
});

describe("the connector", () => {
  let server: Server;
  let port: number;
  const accepted: string[] = [];

  beforeEach(async () => {
    accepted.length = 0;
    server = createServer((socket) => {
      accepted.push(socket.remoteAddress ?? "");
      socket.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  type Connector = (
    opts: { host: string; port: number; localAddress?: string },
    lookup: unknown,
    signal: AbortSignal
  ) => Promise<import("node:net").Socket>;

  const connectorFor = (address: string, host = "db.invalid") =>
    toMssqlConfig(
      { ...settings, host, port },
      { host, address, family: 4 },
      options
    ).options!.connector as Connector;

  it("dials the checked address, never looking the name up", async () => {
    const lookup = vi.fn();
    const socket = await connectorFor("127.0.0.1")(
      { host: "db.invalid", port },
      lookup,
      new AbortController().signal
    );
    try {
      expect(socket.remoteAddress).toBe("127.0.0.1");
      expect(socket.remotePort).toBe(port);
    } finally {
      socket.destroy();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a redirect to another server or port", async () => {
    const connector = connectorFor("127.0.0.1");
    const signal = new AbortController().signal;
    await expect(
      connector({ host: "worker.invalid", port }, vi.fn(), signal)
    ).rejects.toThrow(/redirect/);
    await expect(
      connector({ host: "db.invalid", port: port + 1 }, vi.fn(), signal)
    ).rejects.toThrow(/redirect/);
    expect(accepted).toEqual([]);
  });

  it("stops when the driver aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("connect timeout"));
    await expect(
      connectorFor("127.0.0.1")(
        { host: "db.invalid", port },
        vi.fn(),
        controller.signal
      )
    ).rejects.toThrow("connect timeout");
  });

  it("rejects when nothing listens", async () => {
    await new Promise((resolve) => server.close(resolve));
    await expect(
      connectorFor("127.0.0.1")(
        { host: "db.invalid", port },
        vi.fn(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
