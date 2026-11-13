// @module-tag int
// @module-tag platform
import type { PostgresConnection } from "../../../adapters/postgres/connect.js";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../../../adapters/types.js";
import { SourceUnreachableError } from "../../../utils/errors.js";
import { Client } from "pg";
import {
  fixtureAdminSettings,
  fixtureSettings,
  fixtureTarget,
} from "../../support/fixtureDb.js";

const options = { connectTimeoutMs: 3000, poolSize: 2, queryTimeoutMs: 5000 };
const ODD_PASSWORD = "p@ss/w%rd'x";
const open: SourceConnection[] = [];

const ODD_ROLE = "zeteo_odd_password";

const asAdmin = async (sql: string) => {
  const admin = new Client({
    ...fixtureAdminSettings(),
    database: "postgres",
    ssl: false,
  });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
};

beforeAll(async () => {
  await asAdmin(`DROP ROLE IF EXISTS ${ODD_ROLE}`);
  await asAdmin(
    `CREATE ROLE ${ODD_ROLE} LOGIN PASSWORD '${ODD_PASSWORD.replace(/'/g, "''")}'`
  );
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asAdmin(`DROP ROLE IF EXISTS ${ODD_ROLE}`);
});

describe("postgres connect", () => {
  it("connects with a password full of URL-special characters", async () => {
    const connection = await postgresAdapter.connect(
      fixtureSettings("ro", { user: ODD_ROLE, password: ODD_PASSWORD }),
      await fixtureTarget(),
      options
    );
    open.push(connection);
    expect(await connection.checkLogin()).toEqual([]);
  });

  it("fails a wrong password at connect, with no driver text", async () => {
    const attempt = postgresAdapter.connect(
      fixtureSettings("ro", { password: "wrong" }),
      await fixtureTarget(),
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
    const target = await fixtureTarget();
    const started = Date.now();
    await expect(
      postgresAdapter.connect(
        fixtureSettings("ro", { port: 1 }),
        target,
        options
      )
    ).rejects.toBeInstanceOf(SourceUnreachableError);
    expect(Date.now() - started).toBeLessThan(options.connectTimeoutMs + 1000);
  });

  it("refuses a write through the connection: the session is read-only", async () => {
    const connection = await postgresAdapter.connect(
      fixtureSettings("rw"),
      await fixtureTarget(),
      options
    );
    open.push(connection);
    // The login holds INSERT on sales.orders; only the session setting stops it.
    const pool = (connection as PostgresConnection).pool;
    await expect(
      pool.query(
        "INSERT INTO sales.orders (id, customer_id, status, total) VALUES (900, 1, 'x', 1)"
      )
    ).rejects.toThrow(/read-only transaction/);
  });

  it("names the application", async () => {
    const connection = await postgresAdapter.connect(
      fixtureSettings("ro"),
      await fixtureTarget(),
      options
    );
    open.push(connection);
    const pool = (connection as PostgresConnection).pool;
    const { rows } = await pool.query("SHOW application_name");
    expect(rows[0].application_name).toBe("zeteo");
  });

  it("dials the checked address, not the name in the settings", async () => {
    const target = await fixtureTarget();
    const connection = await postgresAdapter.connect(
      fixtureSettings("ro", { host: "does-not-resolve.invalid" }),
      target,
      options
    );
    open.push(connection);
    expect(await connection.checkLogin()).toEqual([]);
  });

  it("turns a catalog query that outlasts the query timeout into SourceUnreachableError", async () => {
    const connection = (await postgresAdapter.connect(
      fixtureSettings("ro"),
      await fixtureTarget(),
      { ...options, queryTimeoutMs: 300 }
    )) as PostgresConnection;
    open.push(connection);
    const started = Date.now();
    await expect(
      connection.guarded((pool) => pool.query("SELECT pg_sleep(5)"))
    ).rejects.toMatchObject({
      name: "SourceUnreachableError",
      message: "The source could not be reached or refused the login",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("turns any driver error from the catalog queries into SourceUnreachableError", async () => {
    const connection = (await postgresAdapter.connect(
      fixtureSettings("ro"),
      await fixtureTarget(),
      options
    )) as PostgresConnection;
    await connection.pool.end();
    await expect(connection.checkLogin()).rejects.toBeInstanceOf(
      SourceUnreachableError
    );
    await expect(connection.readSchema(["sales"])).rejects.toBeInstanceOf(
      SourceUnreachableError
    );
  });
});
