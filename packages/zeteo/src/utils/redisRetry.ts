import { logger } from "./logger.js";

const MAX_DELAY_MS = 5_000;
const WARN_EVERY = 10;

/**
 * ioredis `retryStrategy` that never gives up. Returning null would end the
 * connection for good after a Redis blip of a second or two. `quit()` still
 * closes the connection: ioredis skips the strategy on a manual close.
 */
export function redisRetryStrategy(times: number): number {
  if (times % WARN_EVERY === 0) {
    logger.warn({ attempts: times }, "Redis still reconnecting");
  }
  return Math.min(times * 200, MAX_DELAY_MS);
}
