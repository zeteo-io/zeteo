import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";

export const windowKey = (userId: string, fingerprint: string): string =>
  `zeteo:dash:rec:${userId}:${fingerprint}`;

/**
 * Whether this dashboard run of `userId` is the one to record: true for the
 * first run of a query (by fingerprint) in a window of `minutes`, which then
 * opens. The window is fixed from that run, never extended by later ones.
 * When Redis fails the run is recorded, rather than a record lost.
 */
export const claim = async (
  userId: string,
  fingerprint: string,
  minutes: number
): Promise<boolean> => {
  try {
    const set = await withinRedisTimeout(
      redis.set(windowKey(userId, fingerprint), "1", "EX", minutes * 60, "NX")
    );
    return set === "OK";
  } catch (err) {
    logger.warn({ err }, "checking a dashboard recording window failed");
    return true;
  }
};
