import { redisRetryStrategy } from "./redisRetry.js";
import { logger } from "./logger.js";
import { Redis } from "ioredis";
import env from "../env.js";

const QUIT_TIMEOUT_MS = 2_000;

/**
 * The one Redis client. It connects in `initializeRedis()`, not on import, so
 * a module that only imports it (a unit test) opens no socket.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: redisRetryStrategy,
});

redis.on("error", (err) => {
  logger.error({ err }, "Redis client error");
});

const connectClient = async (client: Redis): Promise<void> => {
  if (client.status === "wait" || client.status === "end") {
    await client.connect();
  }
};

export const initializeRedis = async (): Promise<void> => {
  if (redis.status === "ready") {
    logger.warn("Redis client already initialized");
    return;
  }
  await connectClient(redis);
  await redis.ping();
  logger.info("Redis client initialized and verified");
};

/**
 * The client retries forever, so while Redis is unreachable QUIT waits in the
 * offline queue and never returns. Dropping the connection instead also ends
 * the reconnect loop; a QUIT that outlasts the timeout is dropped the same way.
 */
export const closeRedisClient = async (client: Redis): Promise<void> => {
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), QUIT_TIMEOUT_MS);
  });
  const quit = client.quit().then(
    () => true,
    () => false
  );
  try {
    if (!(await Promise.race([quit, timedOut]))) client.disconnect();
  } finally {
    clearTimeout(timer);
  }
};

export const closeRedisConnection = async (): Promise<void> => {
  await closeRedisClient(redis);
};
