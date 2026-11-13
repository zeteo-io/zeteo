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

// Extends the lease's own member only while it is still held: a lease that
// has lapsed (expired, released, or dropped by a later acquire) is not taken
// back, so a renewal never pushes the count past the limit.
const RENEW = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
local expires = redis.call("ZSCORE", KEYS[1], ARGV[2])
if not expires or tonumber(expires) <= now then return 0 end
redis.call("ZADD", KEYS[1], "XX", now + ttl, ARGV[2])
if redis.call("PTTL", KEYS[1]) < ttl then redis.call("PEXPIRE", KEYS[1], ttl) end
return 1`;

export interface Lease {
  /** Gives the slot back. Harmless when repeated; never throws. */
  release(): Promise<void>;
  /** Holds the slot `ttlMs` from now, if it is still held. Never throws. */
  renew(ttlMs: number): Promise<void>;
}

/**
 * Takes one of `limit` slots under `key` for at most `ttlMs`. Returns the
 * lease, or null when all `limit` are taken; throws a 503 when Redis fails
 * or does not answer within its bound. A release or renewal that fails or
 * does not answer in time is logged, and the lease then lapses at its expiry.
 */
export const acquireLease = async (
  key: string,
  limit: number,
  ttlMs: number
): Promise<Lease | null> => {
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
  return {
    release: async () => {
      try {
        await withinRedisTimeout(redis.zrem(redisKey, member));
      } catch (err) {
        logger.warn({ err, key }, "releasing a lease failed");
      }
    },
    renew: async (renewTtlMs) => {
      try {
        const renewed = await withinRedisTimeout(
          redis.eval(RENEW, 1, redisKey, renewTtlMs, member)
        );
        if (renewed !== 1)
          logger.warn({ key }, "a lease lapsed before renewal");
      } catch (err) {
        logger.warn({ err, key }, "renewing a lease failed");
      }
    },
  };
};
