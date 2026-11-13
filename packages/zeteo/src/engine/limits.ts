import { TooManyRequestsError } from "../utils/errors.js";
import { acquireLease, type Lease } from "./leases.js";
import type { RunLimits } from "../adapters/types.js";
import { logger } from "../utils/logger.js";

/** What one run may return, by entry point. */
export const LIMIT_PROFILES = {
  api: { defaultRows: 1000, maxRows: 50_000, maxBytes: 10 * 1024 * 1024 },
  mcp: { defaultRows: 100, maxRows: 5000, maxBytes: 1024 * 1024 },
} as const;

/** Where a run came from: a query over the API or MCP, or an export. */
export type EntryPoint = "api" | "mcp" | "export";

/** The entry points that run a query and return its rows at once. */
export type QueryEntryPoint = keyof typeof LIMIT_PROFILES;

/** Queries one user may have running at once, across every replica. */
export const USER_CONCURRENCY = 2;
/** Queries one source may be running at once, across every replica. */
export const SOURCE_CONCURRENCY = 5;
/** How long a lease outlives the run's own time limit, so it cannot lapse while the run is still ending. */
export const LEASE_GRACE_MS = 5000;
const RETRY_AFTER_SECONDS = 1;

/** How long an export may run, from its start to its last row, time waiting on its reader included. */
export const EXPORT_TIMEOUT_MS = 600_000;
/** Exports one user may have running at once, across every replica. */
export const EXPORT_USER_CONCURRENCY = 1;
/** Exports one source may be running at once, across every replica. */
export const EXPORT_SOURCE_CONCURRENCY = 2;
/** How long an export's lease lasts unless renewed: one whose process died frees its slot this soon. */
export const EXPORT_LEASE_MS = 30_000;
/** How often a running export renews its leases. */
export const EXPORT_LEASE_RENEW_MS = 10_000;

/**
 * The run's limits but its deadline, which is set when the run is about to
 * start: the rows the query asked for (or the profile's default), never more
 * than the profile's or the source's maximum; the profile's byte cap; the
 * source's time limit.
 */
export const runLimits = (
  entryPoint: QueryEntryPoint,
  requestedRows: number | undefined,
  source: { rowCap: number; timeoutMs: number }
): Omit<RunLimits, "deadlineAt"> => {
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

/**
 * Releases every lease, each whatever the others do. A release that fails is
 * logged, not thrown: its lease lapses at its expiry, and the run it guarded
 * has already ended.
 */
const releaseAll = async (...leases: Lease[]): Promise<void> => {
  const results = await Promise.allSettled(leases.map((l) => l.release()));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason }, "releasing a run lease failed");
    }
  }
};

/** One of the two slots a run takes: under which key, how many, and the refusal when all are taken. */
interface Slot {
  key: string;
  limit: number;
  refuse: () => TooManyRequestsError;
}

/**
 * Takes the user's slot, then the source's, each for `ttlMs`, and returns
 * both as one lease. Refuses with the slot's 429, or 503 when Redis fails,
 * holding neither: a lease already taken is released without waiting for
 * Redis.
 */
const acquirePair = async (
  user: Slot,
  source: Slot,
  ttlMs: number
): Promise<Lease> => {
  const userLease = await acquireLease(user.key, user.limit, ttlMs);
  if (!userLease) throw user.refuse();
  let sourceLease: Lease | null;
  try {
    sourceLease = await acquireLease(source.key, source.limit, ttlMs);
  } catch (err) {
    void releaseAll(userLease);
    throw err;
  }
  if (!sourceLease) {
    void releaseAll(userLease);
    throw source.refuse();
  }
  const held = sourceLease;
  return {
    release: () => releaseAll(held, userLease),
    renew: async (renewTtlMs) => {
      await Promise.all([held.renew(renewTtlMs), userLease.renew(renewTtlMs)]);
    },
  };
};

/**
 * Takes a query slot for the user, then one for the source, each for
 * `ttlMs`, and returns their release, which never throws. Refuses with 429
 * `too_many_queries` or `source_busy`, or 503 when Redis fails, holding
 * neither.
 */
export const acquireRunLeases = async (
  userId: string,
  sourceId: string,
  ttlMs: number
): Promise<() => Promise<void>> => {
  const lease = await acquirePair(
    {
      key: `user:${userId}`,
      limit: USER_CONCURRENCY,
      refuse: () =>
        new TooManyRequestsError(
          RETRY_AFTER_SECONDS,
          `At most ${USER_CONCURRENCY} queries may run at once for one user`,
          "too_many_queries"
        ),
    },
    {
      key: `source:${sourceId}`,
      limit: SOURCE_CONCURRENCY,
      refuse: () =>
        new TooManyRequestsError(
          RETRY_AFTER_SECONDS,
          "The source is running as many queries as it allows; retry shortly",
          "source_busy"
        ),
    },
    ttlMs
  );
  return lease.release;
};

/**
 * Takes an export slot for the user, then one for the source, each for
 * `ttlMs` and counted apart from queries; the export renews them while it
 * runs. Refuses with 429 `too_many_exports` or `source_busy`, or 503 when
 * Redis fails, holding neither.
 */
export const acquireExportLeases = (
  userId: string,
  sourceId: string,
  ttlMs: number
): Promise<Lease> =>
  acquirePair(
    {
      key: `export:user:${userId}`,
      limit: EXPORT_USER_CONCURRENCY,
      refuse: () =>
        new TooManyRequestsError(
          RETRY_AFTER_SECONDS,
          `At most ${EXPORT_USER_CONCURRENCY} export may run at once for one user`,
          "too_many_exports"
        ),
    },
    {
      key: `export:source:${sourceId}`,
      limit: EXPORT_SOURCE_CONCURRENCY,
      refuse: () =>
        new TooManyRequestsError(
          RETRY_AFTER_SECONDS,
          "The source is running as many exports as it allows; retry shortly",
          "source_busy"
        ),
    },
    ttlMs
  );
