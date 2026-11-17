import { withinRedisTimeout } from "../utils/redisTimeout.js";
import type { ColumnType } from "../adapters/types.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";

/**
 * A dashboard run's result as it is kept: the first time zeteo keeps query
 * results anywhere, briefly, in Redis, for the dashboard entry point only.
 */
export interface CachedResult {
  columns: { name: string; type: ColumnType }[];
  rows: unknown[][];
  truncated: boolean;
  truncated_by?: "rows" | "bytes";
  /** When the result was read from the source, ISO 8601. */
  cached_at: string;
}

export const resultKey = (fingerprint: string): string =>
  `zeteo:dash:result:${fingerprint}`;

/** The result kept under `fingerprint`, or null; Redis failing is a miss. */
export const get = async (
  fingerprint: string
): Promise<CachedResult | null> => {
  try {
    const text = await withinRedisTimeout(redis.get(resultKey(fingerprint)));
    return text === null ? null : (JSON.parse(text) as CachedResult);
  } catch (err) {
    logger.warn({ err }, "reading a dashboard result from the cache failed");
    return null;
  }
};

/**
 * Keeps `result` under `fingerprint` for `ttlSeconds`, unless its JSON is
 * over `maxBytes`. Never throws: a result that is not kept is only a miss
 * for the next run.
 */
export const set = async (
  fingerprint: string,
  result: CachedResult,
  ttlSeconds: number,
  maxBytes: number
): Promise<void> => {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) > maxBytes) return;
  try {
    await withinRedisTimeout(
      redis.set(resultKey(fingerprint), text, "EX", ttlSeconds)
    );
  } catch (err) {
    logger.warn({ err }, "keeping a dashboard result in the cache failed");
  }
};
