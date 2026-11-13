import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import { randomUUID } from "crypto";

export const leaseKey = (key: string): string => `zeteo:lease:${key}`;

// One sorted set per key, each member a lease scored by when it expires, on
// Redis's clock so every replica agrees. Expired members are dropped before
// counting, so a lease its holder never released frees itself. The key itself
// lives as long as its longest lease.
const ACQUIRE = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("ZCARD", KEYS[1]) >= limit then return 0 end
redis.call("ZADD", KEYS[1], now + ttl, ARGV[3])
if redis.call("PTTL", KEYS[1]) < ttl then redis.call("PEXPIRE", KEYS[1], ttl) end
return 1`;

/**
 * Takes one of `limit` slots under `key` for at most `ttlMs`. Returns its
 * release, or null when all `limit` are taken; throws a 503 when Redis fails
 * or does not answer within its bound. Releasing twice is harmless; a release
 * that fails or does not answer in time is logged, and the lease then lapses
 * at its expiry.
 */
export const acquireLease = async (
  key: string,
  limit: number,
  ttlMs: number
): Promise<(() => Promise<void>) | null> => {
  const redisKey = leaseKey(key);
  const member = randomUUID();
  let taken: unknown;
  try {
    taken = await withinRedisTimeout(
      redis.eval(ACQUIRE, 1, redisKey, limit, ttlMs, member)
    );
  } catch (err) {
    logger.warn({ err, key }, "taking a lease failed");
    throw new ServiceUnavailableError(
      "Query limits cannot be checked right now; retry shortly"
    );
  }
  if (taken !== 1) return null;
  return async () => {
    try {
      await withinRedisTimeout(redis.zrem(redisKey, member));
    } catch (err) {
      logger.warn({ err, key }, "releasing a lease failed");
    }
  };
};
