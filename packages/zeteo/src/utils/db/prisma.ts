import { PrismaClient } from "../../../prisma/generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";
import { logger } from "../logger.js";
import env from "../../env.js";

// Columns are `timestamp without time zone` holding UTC, and raw SQL compares
// them with NOW(), which converts in the session's time zone: pinned to UTC
// here, whatever the server's default.
export const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  options: "-c timezone=UTC",
  max: env.DB_POOL_MAX,
  min: env.DB_POOL_MIN,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
};

const pool = new Pool(poolConfig);

// /health's own connection: with every pool slot busy, a probe queued behind
// the requests would report Postgres down while it answers them.
const probePool = new Pool({
  ...poolConfig,
  max: 1,
  min: 0,
  connectionTimeoutMillis: 2000,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    maxWait: env.DB_TRANSACTION_MAX_WAIT_MS,
    timeout: env.DB_TRANSACTION_TIMEOUT_MS,
  },
});

/**
 * Ends `p`, waiting at most `timeoutMs`: `end()` waits for every checked-out
 * client to be released, so one stuck query would hold the shutdown with it.
 * False when the wait ran out, the clients still open.
 */
export const endPool = async (p: Pool, timeoutMs: number): Promise<boolean> => {
  const ending = p.end().then(() => true);
  // A rejection after the wait ran out has no one left to answer.
  ending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    ending,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    }),
  ]);
  clearTimeout(timer);
  return ended;
};

const POOL_END_TIMEOUT_MS = 3000;

export const disconnectDatabase = async (
  timeoutMs: number = POOL_END_TIMEOUT_MS
): Promise<void> => {
  await prisma.$disconnect();
  const [ended, probeEnded] = await Promise.all([
    endPool(pool, timeoutMs),
    endPool(probePool, timeoutMs),
  ]);
  if (!ended || !probeEnded) {
    logger.warn(
      { checkedOut: pool.totalCount - pool.idleCount },
      "Database connections still checked out at shutdown"
    );
  }
};

/** Throws unless Postgres answers a query on the probe's own connection. */
export const healthCheck = async (): Promise<void> => {
  await probePool.query("SELECT 1");
};

export type { Prisma } from "../../../prisma/generated/client/index.js";
export { prisma };
