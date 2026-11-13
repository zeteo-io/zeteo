import type { AzureSqlSettings } from "../../adapters/azure-sql/settings.js";
import { parseAllowedHosts, resolveAllowed } from "../../sources/network.js";
import type { ResolvedTarget, Resolver } from "../../sources/network.js";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sql from "mssql";

export const MSSQL_FIXTURE_DATABASE = "zeteo_fixture";

export const MSSQL_FIXTURE_LOGINS = {
  ro: { user: "zeteo_ro", password: "Ro-test-password-1" },
  rw: { user: "zeteo_rw", password: "Rw-test-password-1" },
  owner: { user: "zeteo_owner", password: "Owner-test-password-1" },
} as const;

export const DEFAULT_TEST_MSSQL_URL = "mssql://sa:Zeteo-test-1@localhost:1463";

const FIXTURE_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mssql/sales.sql"
);

/** The test SQL Server, from `TEST_MSSQL_URL`. */
export const mssqlServer = () => {
  const url = new URL(process.env.TEST_MSSQL_URL ?? DEFAULT_TEST_MSSQL_URL);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 1433),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
};

/**
 * Settings for the fixture database as one of its logins. The container's
 * certificate is self-signed, so the fixture is trusted rather than verified.
 */
export const mssqlFixtureSettings = (
  login: keyof typeof MSSQL_FIXTURE_LOGINS,
  overrides: Partial<AzureSqlSettings> = {}
): AzureSqlSettings => ({
  host: mssqlServer().host,
  port: mssqlServer().port,
  database: MSSQL_FIXTURE_DATABASE,
  ...MSSQL_FIXTURE_LOGINS[login],
  tls: "trust-server-certificate",
  ...overrides,
});

/** Settings for the fixture database as the server's administrator. */
export const mssqlAdminSettings = (): AzureSqlSettings => {
  const { host, port, user, password } = mssqlServer();
  return {
    host,
    port,
    database: MSSQL_FIXTURE_DATABASE,
    user,
    password,
    tls: "trust-server-certificate",
  };
};

// As fixtureDb.ts: a published container port answers on IPv4.
const ipv4First: Resolver = async (host) => {
  const found = await lookup(host, { all: true, verbatim: false });
  return found.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

export const mssqlFixtureTarget = (): Promise<ResolvedTarget> =>
  resolveAllowed(
    mssqlServer().host,
    parseAllowedHosts(process.env.SOURCE_ALLOWED_HOSTS ?? ""),
    ipv4First
  );

/** Settings the service can dial, as `sourceSettings` does for Postgres. */
export const mssqlSourceSettings = (
  login: keyof typeof MSSQL_FIXTURE_LOGINS,
  overrides: Partial<AzureSqlSettings> = {}
): AzureSqlSettings => {
  const base = mssqlFixtureSettings(login);
  return {
    ...base,
    host: base.host === "localhost" ? "127.0.0.1" : base.host,
    ...overrides,
  };
};

const adminPool = async (database: string) => {
  const { host, port, user, password } = mssqlServer();
  const pool = new sql.ConnectionPool({
    server: host === "localhost" ? "127.0.0.1" : host,
    port,
    user,
    password,
    database,
    connectionTimeout: 10_000,
    requestTimeout: 60_000,
    options: { encrypt: true, trustServerCertificate: true },
  });
  return pool.connect();
};

/** Runs each batch as the server's administrator, in `database` (default the fixture's). */
export const asMssqlAdmin = async (
  batches: string[],
  database = MSSQL_FIXTURE_DATABASE
): Promise<void> => {
  const pool = await adminPool(database);
  try {
    for (const batch of batches) await pool.request().batch(batch);
  } finally {
    await pool.close();
  }
};

export const quoteMssqlIdent = (name: string) =>
  `[${name.replace(/]/g, "]]")}]`;
export const quoteMssqlLiteral = (value: string) =>
  `N'${value.replace(/'/g, "''")}'`;

/** Creates the login, or resets its password if it exists. */
export const ensureLoginSql = (user: string, password: string) => `
  IF SUSER_ID(${quoteMssqlLiteral(user)}) IS NULL
    CREATE LOGIN ${quoteMssqlIdent(user)} WITH PASSWORD = ${quoteMssqlLiteral(password)}, CHECK_POLICY = OFF;
  ELSE
    ALTER LOGIN ${quoteMssqlIdent(user)} WITH PASSWORD = ${quoteMssqlLiteral(password)}, CHECK_POLICY = OFF;
  ALTER LOGIN ${quoteMssqlIdent(user)} ENABLE;`;

/** Ends the login's sessions, then drops it, if it exists. */
export const dropLoginSql = (user: string) => `
  DECLARE @kill nvarchar(max) = N'';
  SELECT @kill += N'KILL ' + CAST(session_id AS nvarchar(12)) + N';'
    FROM sys.dm_exec_sessions WHERE login_name = ${quoteMssqlLiteral(user)};
  EXEC (@kill);
  IF SUSER_ID(${quoteMssqlLiteral(user)}) IS NOT NULL
    DROP LOGIN ${quoteMssqlIdent(user)};`;

/**
 * Recreates the Azure SQL fixture: the `zeteo_fixture` database on the test
 * SQL Server and its logins. Throws with how to start the server when it
 * cannot be reached.
 */
export const recreateMssqlFixture = async (): Promise<void> => {
  const { host, port } = mssqlServer();
  let master: sql.ConnectionPool;
  try {
    master = await adminPool("master");
  } catch (err) {
    throw new Error(
      `SQL Server is not reachable at ${host}:${port} (TEST_MSSQL_URL). ` +
        "Start it from the repository root with `docker compose up -d mssql` " +
        "and wait for it to be healthy.",
      { cause: err }
    );
  }
  const name = quoteMssqlIdent(MSSQL_FIXTURE_DATABASE);
  try {
    await master.request().batch(`
      IF DB_ID(${quoteMssqlLiteral(MSSQL_FIXTURE_DATABASE)}) IS NOT NULL
      BEGIN
        ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE ${name};
      END`);
    for (const { user, password } of Object.values(MSSQL_FIXTURE_LOGINS)) {
      await master.request().batch(ensureLoginSql(user, password));
    }
    await master.request().batch(`CREATE DATABASE ${name}`);
  } finally {
    await master.close();
  }
  const batches = (await readFile(FIXTURE_SQL, "utf8"))
    .split(/^GO\s*$/m)
    .map((batch) => batch.trim())
    .filter(Boolean);
  await asMssqlAdmin(batches);
};
