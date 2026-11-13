// @module-tag int
// @module-tag platform
import type { AzureSqlConnection } from "../../../adapters/azure-sql/connect.js";
import { parseAllowedHosts, resolveAllowed } from "../../../sources/network.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { startSilentServer } from "../../support/silentServer.js";
import dns from "node:dns";
import {
  asMssqlAdmin,
  dropLoginSql,
  ensureLoginSql,
  mssqlAdminSettings,
  mssqlFixtureSettings,
  mssqlFixtureTarget,
  quoteMssqlIdent,
} from "../../support/mssqlFixture.js";
import {
  SourceTypeUnavailableError,
  SourceUnreachableError,
} from "../../../utils/errors.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 5000 };
const ODD_LOGIN = "zeteo_odd_password";
const ODD_PASSWORD = "p@ss/w%rd'x;Server=evil;]";
const open: SourceConnection[] = [];

const connect = async (
  settings: ReturnType<typeof mssqlFixtureSettings>,
  opts = options
) => {
  const connection = await azureSqlAdapter.connect(
    settings,
    await mssqlFixtureTarget(),
    opts
  );
  open.push(connection);
  return connection as AzureSqlConnection;
};

beforeAll(async () => {
  await asMssqlAdmin([dropLoginSql(ODD_LOGIN)], "master");
  await asMssqlAdmin([ensureLoginSql(ODD_LOGIN, ODD_PASSWORD)], "master");
  await asMssqlAdmin([
    `IF USER_ID('${ODD_LOGIN}') IS NULL CREATE USER ${quoteMssqlIdent(ODD_LOGIN)} FOR LOGIN ${quoteMssqlIdent(ODD_LOGIN)}`,
  ]);
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asMssqlAdmin([`DROP USER IF EXISTS ${quoteMssqlIdent(ODD_LOGIN)}`]);
  await asMssqlAdmin([dropLoginSql(ODD_LOGIN)], "master");
});

describe("azure-sql connect", () => {
  it("connects with a password full of connection-string characters", async () => {
    const connection = await connect(
      mssqlFixtureSettings("ro", { user: ODD_LOGIN, password: ODD_PASSWORD })
    );
    expect(await connection.checkLogin()).toEqual([]);
  });

  it("fails a wrong password at connect, with no driver text", async () => {
    const attempt = azureSqlAdapter.connect(
      mssqlFixtureSettings("ro", { password: "wrong" }),
      await mssqlFixtureTarget(),
      options
    );
    await expect(attempt).rejects.toBeInstanceOf(SourceUnreachableError);
    await expect(attempt).rejects.toMatchObject({
      message: "The source could not be reached or refused the login",
      statusCode: 502,
      code: "source_unreachable",
    });
  });

  it("fails a closed port within the connect timeout", async () => {
    const started = Date.now();
    await expect(
      azureSqlAdapter.connect(
        mssqlFixtureSettings("ro", { port: 1 }),
        await mssqlFixtureTarget(),
        options
      )
    ).rejects.toBeInstanceOf(SourceUnreachableError);
    expect(Date.now() - started).toBeLessThan(options.connectTimeoutMs + 1000);
  });

  it("fails a server that accepts and never answers within the connect timeout", async () => {
    const silent = await startSilentServer();
    try {
      const started = Date.now();
      await expect(
        azureSqlAdapter.connect(
          mssqlFixtureSettings("ro", { port: silent.port }),
          await mssqlFixtureTarget(),
          { ...options, connectTimeoutMs: 1500 }
        )
      ).rejects.toBeInstanceOf(SourceUnreachableError);
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await silent.close();
    }
  });

  it("dials the address the network rules approved, never looking up the name in the settings", async () => {
    const fixture = await mssqlFixtureTarget();
    const invented = "zeteo-mssql-fixture.invalid";
    const target = await resolveAllowed(
      invented,
      parseAllowedHosts(invented),
      async () => [{ address: fixture.address, family: fixture.family }]
    );
    expect(target).toEqual({
      host: invented,
      address: fixture.address,
      family: fixture.family,
    });
    const lookup = vi.spyOn(dns, "lookup");
    try {
      const connection = await azureSqlAdapter.connect(
        mssqlFixtureSettings("ro", { host: invented }),
        target,
        options
      );
      open.push(connection);
      expect(await connection.checkLogin()).toEqual([]);
      expect(lookup).not.toHaveBeenCalledWith(
        invented,
        expect.anything(),
        expect.anything()
      );
      expect(
        lookup.mock.calls.some(([host]) => String(host).includes("invalid"))
      ).toBe(false);
    } finally {
      lookup.mockRestore();
    }
  });

  it("verifies the certificate under tls verify: the fixture's self-signed one is refused", async () => {
    await expect(
      azureSqlAdapter.connect(
        mssqlFixtureSettings("ro", { tls: "verify" }),
        await mssqlFixtureTarget(),
        options
      )
    ).rejects.toBeInstanceOf(SourceUnreachableError);
  });

  it("encrypts the connection and names the application", async () => {
    const admin = await connect(mssqlAdminSettings());
    const { recordset } = await admin.pool
      .request()
      .query(
        "SELECT c.encrypt_option, APP_NAME() AS app FROM sys.dm_exec_connections c WHERE c.session_id = @@SPID"
      );
    expect(recordset[0]).toEqual({ encrypt_option: "TRUE", app: "zeteo" });
  });

  it("refuses to run queries until the adapter supports them", async () => {
    const connection = await connect(mssqlFixtureSettings("ro"));
    await expect(
      connection.runQuery(
        {
          references: [],
          columns: [],
          warnings: [],
          limit: undefined,
          offset: 0,
        },
        { maxRows: 1, maxBytes: 1, timeoutMs: 1000 }
      )
    ).rejects.toBeInstanceOf(SourceTypeUnavailableError);
  });

  it("turns a catalog query that outlasts the query timeout into SourceUnreachableError", async () => {
    const connection = await connect(mssqlFixtureSettings("ro"), {
      ...options,
      queryTimeoutMs: 300,
    });
    const started = Date.now();
    await expect(
      connection.guarded((pool) =>
        pool.request().query("WAITFOR DELAY '00:00:05'")
      )
    ).rejects.toMatchObject({
      name: "SourceUnreachableError",
      message: "The source could not be reached or refused the login",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("turns any driver error from the catalog queries into SourceUnreachableError", async () => {
    const connection = await connect(mssqlFixtureSettings("ro"));
    await connection.pool.close();
    await expect(connection.checkLogin()).rejects.toBeInstanceOf(
      SourceUnreachableError
    );
    await expect(connection.readSchema(["sales"])).rejects.toBeInstanceOf(
      SourceUnreachableError
    );
  });
});
