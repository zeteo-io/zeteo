import type { ServerInstance } from "../../index.js";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const FIXTURE_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/postgres/sales.sql"
);
const PROBE_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/postgres/probe.sql"
);

let server: ServerInstance | null = null;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

/** Creates `<db>_test` when it is missing, through the server's maintenance database. */
async function ensureTestDatabase(databaseUrl: string) {
  const { Client } = await import("pg");
  const target = new URL(databaseUrl);
  const name = target.pathname.slice(1);
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name]
    );
    if (found.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Recreates the source fixture: the `zeteo_fixture` database and its roles on
 * the test server, the way source tests find them. The test user is a
 * superuser, so it can create both.
 */
async function recreateFixtureDatabase(databaseUrl: string) {
  const { Client } = await import("pg");
  const { readFile } = await import("fs/promises");
  const { FIXTURE_DATABASE, FIXTURE_OWNED_DATABASE, FIXTURE_ROLES } =
    await import("../support/fixtureDb.js");
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    for (const name of [FIXTURE_DATABASE, FIXTURE_OWNED_DATABASE]) {
      await client.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`
      );
    }
    for (const { user, password } of Object.values(FIXTURE_ROLES)) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(user)}`);
      await client.query(
        `CREATE ROLE ${quoteIdent(user)} LOGIN PASSWORD ${quoteLiteral(password)}`
      );
    }
    await client.query(`CREATE DATABASE ${quoteIdent(FIXTURE_DATABASE)}`);
    // The owner has revoked CREATE from itself: only ownership is left to find.
    await client.query(
      `CREATE DATABASE ${quoteIdent(FIXTURE_OWNED_DATABASE)} OWNER ${quoteIdent(FIXTURE_ROLES.dbOwner.user)}`
    );
    await client.query(
      `REVOKE CREATE ON DATABASE ${quoteIdent(FIXTURE_OWNED_DATABASE)} FROM ${quoteIdent(FIXTURE_ROLES.dbOwner.user)}`
    );
  } finally {
    await client.end();
  }
  const fixture = new URL(databaseUrl);
  fixture.pathname = `/${FIXTURE_DATABASE}`;
  const loader = new Client({ connectionString: fixture.toString() });
  await loader.connect();
  try {
    await loader.query(await readFile(FIXTURE_SQL, "utf8"));
    await loader.query(await readFile(PROBE_SQL, "utf8"));
    // Session defaults a user query must override to produce its wire forms:
    // a zone off UTC by a fraction of an hour, day-first dates and floats
    // printed short.
    const ro = `ALTER ROLE ${quoteIdent(FIXTURE_ROLES.ro.user)} IN DATABASE ${quoteIdent(FIXTURE_DATABASE)}`;
    await loader.query(`
      ${ro} SET timezone = 'America/St_Johns';
      ${ro} SET datestyle = 'SQL, DMY';
      ${ro} SET extra_float_digits = 0;
    `);
  } finally {
    await loader.end();
  }
}

export async function setup() {
  // globalSetup runs in the main vitest process, where the config's `env`
  // option doesn't apply: load the same environment the workers get.
  const { loadTestEnv } = await import("./testEnv.js");
  Object.assign(process.env, loadTestEnv());
  // Sets SERVICE_NAME, which the logger needs; after the test env so
  // dotenv's `.env` does not win over it.
  await import("../../preload.js");

  // Bring the test database up to date. Non-destructive: migrations apply
  // forward; tests clean up what they create.
  await ensureTestDatabase(process.env.DATABASE_URL!);
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: packageRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  });

  await recreateFixtureDatabase(process.env.DATABASE_URL!);

  // Earlier runs would otherwise leave state in Redis db 1.
  const { redis } = await import("../../utils/redis.js");
  await redis.connect();
  await redis.flushdb();
  await redis.quit();

  const { createAppServer } = await import("../../index.js");
  server = createAppServer(Number(process.env.PORT ?? 4201), {
    refreshJob: false,
  });
  await server.start();
}

export async function teardown() {
  await server?.stop();
  server = null;
  // A lingering ioredis socket can keep the process alive. Force the exit
  // if so, keeping the exit code vitest sets: an unconditional exit(0)
  // would report a failing run as passing.
  setTimeout(() => process.exit(), 5000).unref();
}
