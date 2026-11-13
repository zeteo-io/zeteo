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
