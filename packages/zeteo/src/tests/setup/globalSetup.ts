import type { ServerInstance } from "../../index.js";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

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

  // Earlier runs would otherwise leave state in Redis db 1.
  const { redis } = await import("../../utils/redis.js");
  await redis.connect();
  await redis.flushdb();
  await redis.quit();

  const { createAppServer } = await import("../../index.js");
  server = createAppServer(Number(process.env.PORT ?? 4201));
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
