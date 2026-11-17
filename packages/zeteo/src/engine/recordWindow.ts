import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";

export const windowKey = (userId: string, identity: string): string =>
  `zeteo:dash:rec:${userId}:${identity}`;

/**
 * Whether this dashboard run of `userId` is the one to record: true for the
 * first run of a query (by its record identity, `recordIdentityOf`) in a window of `minutes`, which then
 * opens. The window is fixed from that run, never extended by later ones.
 * When Redis fails the run is recorded, rather than a record lost.
 */
export const claim = async (
  userId: string,
  identity: string,
  minutes: number
): Promise<boolean> => {
  try {
    const set = await withinRedisTimeout(
      redis.set(windowKey(userId, identity), "1", "EX", minutes * 60, "NX")
    );
    return set === "OK";
  } catch (err) {
    logger.warn({ err }, "checking a dashboard recording window failed");
    return true;
  }
};

/**
 * Closes the window `claim` opened, for a run whose record could not be
 * written: the next run then records instead. Never throws; a window that
 * cannot be closed lapses at its expiry.
 */
export const release = async (
  userId: string,
  identity: string
): Promise<void> => {
  try {
    await withinRedisTimeout(redis.del(windowKey(userId, identity)));
  } catch (err) {
    logger.warn({ err }, "closing a dashboard recording window failed");
  }
};

/**
 * The window a failed run of the query under `identity` is recorded in:
 * apart from its successful runs', so a failure never hides a success.
 */
export const failureWindowOf = (identity: string): string =>
  `${identity}:failed`;
