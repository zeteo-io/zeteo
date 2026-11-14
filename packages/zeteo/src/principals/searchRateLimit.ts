import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { TooManyRequestsError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";

/** Principal searches one caller may make in a window. */
export const SEARCH_LIMIT_PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

/**
 * Counts one search by `userId` in a fixed one-minute window in Redis, the way
 * the MCP rate limit does (INCR, EXPIRE on the first, TTL for `Retry-After`),
 * and throws `TooManyRequestsError` past the limit. A Redis that fails or does
 * not answer lets the search through.
 */
export const countSearch = async (userId: string): Promise<void> => {
  const key = `zeteo:principals:search:rl:${userId}`;
  let retryAfter: number | undefined;
  try {
    const count = await withinRedisTimeout(redis.incr(key));
    if (count === 1) {
      await withinRedisTimeout(redis.expire(key, WINDOW_SECONDS));
      return;
    }
    const ttl = await withinRedisTimeout(redis.ttl(key));
    // A key whose first call failed to expire would otherwise count forever.
    if (ttl < 0) await withinRedisTimeout(redis.expire(key, WINDOW_SECONDS));
    if (count > SEARCH_LIMIT_PER_MINUTE) {
      retryAfter = ttl > 0 ? ttl : WINDOW_SECONDS;
    }
  } catch (err) {
    logger.error(
      { err },
      "principal search rate limiter unavailable; allowing"
    );
    return;
  }
  if (retryAfter !== undefined) throw new TooManyRequestsError(retryAfter);
};
