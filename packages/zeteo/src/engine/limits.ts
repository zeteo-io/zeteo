import { TooManyRequestsError } from "../utils/errors.js";
import type { RunLimits } from "../adapters/types.js";
import { logger } from "../utils/logger.js";
import { acquireLease } from "./leases.js";

/** What one run may return, by entry point. */
export const LIMIT_PROFILES = {
  api: { defaultRows: 1000, maxRows: 50_000, maxBytes: 10 * 1024 * 1024 },
  mcp: { defaultRows: 100, maxRows: 5000, maxBytes: 1024 * 1024 },
} as const;

export type EntryPoint = keyof typeof LIMIT_PROFILES;

/** Queries one user may have running at once, across every replica. */
export const USER_CONCURRENCY = 2;
/** Queries one source may be running at once, across every replica. */
export const SOURCE_CONCURRENCY = 5;
/** How long a lease outlives the run's own time limit, so it cannot lapse while the run is still ending. */
export const LEASE_GRACE_MS = 5000;
const RETRY_AFTER_SECONDS = 1;

/**
 * The run's limits: the rows the query asked for (or the profile's default),
 * never more than the profile's or the source's maximum; the profile's byte
 * cap; the source's time limit.
 */
export const runLimits = (
  entryPoint: EntryPoint,
  requestedRows: number | undefined,
  source: { rowCap: number; timeoutMs: number }
): RunLimits => {
  const profile = LIMIT_PROFILES[entryPoint];
  return {
    maxRows: Math.min(
      requestedRows ?? profile.defaultRows,
      profile.maxRows,
      source.rowCap
    ),
    maxBytes: profile.maxBytes,
    timeoutMs: source.timeoutMs,
  };
};

type Release = () => Promise<void>;

/**
 * Releases every lease, each whatever the others do. A release that fails is
 * logged, not thrown: its lease lapses at its expiry, and the run it guarded
 * has already ended.
 */
const releaseAll = async (...releases: Release[]): Promise<void> => {
  const results = await Promise.allSettled(releases.map((r) => r()));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason }, "releasing a query lease failed");
    }
  }
};

/**
 * Takes a slot for the user, then one for the source, each for `ttlMs`, and
 * returns their release, which never throws. Refuses with 429
 * `too_many_queries` or `source_busy`, holding neither.
 */
export const acquireRunLeases = async (
  userId: string,
  sourceId: string,
  ttlMs: number
): Promise<Release> => {
  const user = await acquireLease(`user:${userId}`, USER_CONCURRENCY, ttlMs);
  if (!user) {
    throw new TooManyRequestsError(
      RETRY_AFTER_SECONDS,
      `At most ${USER_CONCURRENCY} queries may run at once for one user`,
      "too_many_queries"
    );
  }
  let source: Release | null;
  try {
    source = await acquireLease(
      `source:${sourceId}`,
      SOURCE_CONCURRENCY,
      ttlMs
    );
  } catch (err) {
    await releaseAll(user);
    throw err;
  }
  if (!source) {
    await releaseAll(user);
    throw new TooManyRequestsError(
      RETRY_AFTER_SECONDS,
      "The source is running as many queries as it allows; retry shortly",
      "source_busy"
    );
  }
  const held = source;
  return () => releaseAll(held, user);
};
