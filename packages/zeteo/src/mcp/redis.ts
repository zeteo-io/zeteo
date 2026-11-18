import { withinRedisTimeout } from "../utils/redisTimeout.js";
import type { RateLimitRedis } from "@tereo-io/mcp";
import type { Redis } from "ioredis";

/**
 * The MCP rate limiter's view of `client`: only the commands it sends, each
 * bounded by `withinRedisTimeout`, so a Redis that does not answer fails the
 * check (which lets the call through) instead of holding the call.
 */
export const rateLimitRedis = (client: Redis): RateLimitRedis => ({
  incr: (key) => withinRedisTimeout(client.incr(key)),
  expire: (key, seconds) => withinRedisTimeout(client.expire(key, seconds)),
  ttl: (key) => withinRedisTimeout(client.ttl(key)),
});

/** How long a caller's instructions are kept: grants change rarely, and the tools stay the source of truth. */
export const INSTRUCTIONS_TTL_SECONDS = 300;

const instructionsKey = (userId: string): string =>
  `zeteo:mcp:instructions:${userId}`;

/** A user's cached instructions, or null; a Redis that fails or does not answer throws. */
export const readCachedInstructions = (
  client: Redis,
  userId: string
): Promise<string | null> =>
  withinRedisTimeout(client.get(instructionsKey(userId)));

/** Keeps a user's instructions for `INSTRUCTIONS_TTL_SECONDS`. */
export const cacheInstructions = async (
  client: Redis,
  userId: string,
  text: string
): Promise<void> => {
  await withinRedisTimeout(
    client.set(instructionsKey(userId), text, "EX", INSTRUCTIONS_TTL_SECONDS)
  );
};
