import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { parse } from "dotenv";
import path from "path";

/** A fixed key for tests only: 32 bytes of 0x07, base64url. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64url");

/** Loopback only: integration tests connect to a fixture database on localhost. */
const TEST_SOURCE_ALLOWED_HOSTS = "127.0.0.0/8,::1/128,localhost";

/** The environment of the `unit` project: unreachable database and Redis, so a unit test that reaches for either fails at once. */
export function loadUnitTestEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    // utils/logger.ts, which route schemas reach through utils/errors.ts,
    // throws at import without it; in the server, preload sets it to the
    // constant "zeteo".
    SERVICE_NAME: "zeteo",
    // Nothing listens on port 1: a unit test that reaches for the database
    // or Redis fails at once instead of touching a real one.
    DATABASE_URL: "postgresql://unit:unit@127.0.0.1:1/unit",
    REDIS_URL: "redis://127.0.0.1:1",
    PUBLIC_URL: "http://localhost:4201",
    TEREO_TEST_MODE: "true",
    ZETEO_MASTER_KEY: TEST_MASTER_KEY,
    SOURCE_ALLOWED_HOSTS: TEST_SOURCE_ALLOWED_HOSTS,
  };
}

/**
 * The test environment: `.env`, pointed at a separate database and Redis db
 * so tests never touch dev data. `globalSetup` migrates the database, then
 * starts one server on 4201 that every test file talks to.
 *
 * `TEST_DATABASE_URL` / `TEST_REDIS_URL`, from the shell or `.env`, override
 * the derived URLs, and `TEST_PORT` the server's port, so suites in two
 * worktrees can run side by side. In Docker (DOCKER_TEST=true) the container
 * environment is used as-is.
 */
export function loadTestEnv(): Record<string, string> {
  if (process.env.DOCKER_TEST === "true") {
    return Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, "../../../.env");
  if (!existsSync(envPath)) {
    throw new Error(
      `.env not found at ${envPath} — copy .env.example and fill it in`
    );
  }
  const env = parse(readFileSync(envPath, "utf-8"));
  const db = new URL(env.DATABASE_URL);
  db.pathname = `${db.pathname}_test`;
  const redis = new URL(env.REDIS_URL);
  redis.pathname = "/1";
  const port = process.env.TEST_PORT ?? env.TEST_PORT ?? "4201";
  return {
    ...env,
    PORT: port,
    PUBLIC_URL: `http://localhost:${port}`,
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL ?? db.toString(),
    REDIS_URL:
      process.env.TEST_REDIS_URL ?? env.TEST_REDIS_URL ?? redis.toString(),
    // The SQL Server of the Azure SQL tests: docker-compose.yml's `mssql`.
    TEST_MSSQL_URL:
      process.env.TEST_MSSQL_URL ??
      env.TEST_MSSQL_URL ??
      "mssql://sa:Zeteo-test-1@localhost:1463",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    TEREO_TEST_MODE: "true",
    ZETEO_MASTER_KEY: TEST_MASTER_KEY,
    SOURCE_ALLOWED_HOSTS: TEST_SOURCE_ALLOWED_HOSTS,
  };
}
