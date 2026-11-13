import { connectChecked, poolSizeFor, readSettings } from "./connect.js";
import type { Source } from "../../prisma/generated/client/index.js";
import type { SourceConnection } from "../adapters/types.js";
import { adapterFor } from "../adapters/index.js";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { typeOf } from "./types.js";
import {
  NotFoundError,
  ServiceUnavailableError,
  SourceArchivedError,
  SourceUnreachableError,
} from "../utils/errors.js";

export const POOL_IDLE_MS = 5 * 60_000;
/** How long closing every pool waits for the calls still running on them. */
export const POOL_DRAIN_MS = 10_000;

interface Entry {
  sourceId: string;
  connection: Promise<SourceConnection>;
  /** Which sealed settings, and what size, the pool was opened with. */
  fingerprint: string;
  /** The newest `updated_at` of the source's row seen by a call on this pool. */
  updatedAt: Date;
  /** Calls running on this pool. */
  active: number;
  /** Taken out of the map: closes once the last running call ends. */
  retired: boolean;
  /** Opening failed: nothing to close. */
  failed: boolean;
  /** Set once the pool is being closed, so it is closed once. */
  closing?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  /** Settles once a retired entry with running calls has closed. */
  drained?: Promise<void>;
  onDrained?: () => void;
}

const entries = new Map<string, Entry>();
/** Per source, the newest `updated_at` this process has seen, pools or not. */
const newestSeen = new Map<string, Date>();

const noteSeen = (sourceId: string, updatedAt: Date): void => {
  const seen = newestSeen.get(sourceId);
  if (!seen || updatedAt > seen) newestSeen.set(sourceId, updatedAt);
};

const isOlderThanSeen = (row: Source): boolean => {
  const seen = newestSeen.get(row.id);
  return seen !== undefined && row.updatedAt < seen;
};
/** Retired entries whose calls are still running. */
const draining = new Set<Entry>();
let stopping = false;

// A settings change seals with a fresh IV and data key, so these two change
// whenever the settings do, on whichever replica made the change. The pool's
// size changes with the source's concurrency settings.
const fingerprintOf = (row: Source): string => {
  const { iv, wrappedKey } = (row.sealedSettings ?? {}) as {
    iv?: unknown;
    wrappedKey?: unknown;
  };
  return JSON.stringify([iv, wrappedKey, poolSizeFor(row)]);
};

const openConnection = (row: Source): Promise<SourceConnection> => {
  const adapter = adapterFor(typeOf(row));
  return connectChecked(
    adapter,
    readSettings(adapter, row.id, row.sealedSettings),
    poolSizeFor(row)
  );
};

const closeEntry = (sourceId: string, entry: Entry): Promise<void> => {
  if (entry.failed) return Promise.resolve();
  entry.closing ??= (async () => {
    try {
      await (await entry.connection).close();
    } catch (err) {
      logger.warn({ err, source_id: sourceId }, "closing a source pool failed");
    }
  })();
  return entry.closing;
};

const retire = (sourceId: string, entry: Entry): Promise<void> => {
  clearTimeout(entry.idleTimer);
  if (entries.get(sourceId) === entry) entries.delete(sourceId);
  if (entry.retired) return entry.drained ?? Promise.resolve();
  entry.retired = true;
  if (entry.active === 0) return closeEntry(sourceId, entry);
  entry.drained = new Promise<void>((resolve) => {
    entry.onDrained = resolve;
  });
  draining.add(entry);
  return Promise.resolve();
};

const armIdleTimer = (sourceId: string, entry: Entry): void => {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void retire(sourceId, entry);
  }, POOL_IDLE_MS);
  // An idle pool must not keep the process alive.
  entry.idleTimer.unref();
};

const acquire = (row: Source): Entry => {
  const fingerprint = fingerprintOf(row);
  let entry = entries.get(row.id);
  // Only a row newer than the pool's replaces it: a call whose read landed
  // before a change uses the pool opened after it.
  if (
    entry &&
    entry.fingerprint !== fingerprint &&
    row.updatedAt > entry.updatedAt
  ) {
    void retire(row.id, entry);
    entry = undefined;
  }
  if (entry && row.updatedAt > entry.updatedAt) {
    entry.updatedAt = row.updatedAt;
  }
  if (!entry) {
    const created: Entry = {
      sourceId: row.id,
      connection: openConnection(row),
      fingerprint,
      updatedAt: row.updatedAt,
      active: 0,
      retired: false,
      failed: false,
    };
    // A pool that failed to open is not kept, so the next call tries again.
    created.connection.catch(() => {
      created.failed = true;
      if (entries.get(row.id) === created) entries.delete(row.id);
    });
    entries.set(row.id, created);
    entry = created;
  }
  clearTimeout(entry.idleTimer);
  entry.active++;
  return entry;
};

const release = async (sourceId: string, entry: Entry): Promise<void> => {
  entry.active--;
  if (entry.active > 0) return;
  if (entry.retired) {
    await closeEntry(sourceId, entry);
    draining.delete(entry);
    entry.onDrained?.();
  } else if (!entry.failed) {
    armIdleTimer(sourceId, entry);
  }
};

/**
 * Runs `fn` on the source's pool, opening it on first use with as many
 * connections as `poolSizeFor` the row. Every call reads the source's row: a
 * pool opened with other settings or another size than the row now holds
 * (changed by another replica) is replaced, and an archived source is refused.
 * Opening checks the source's host against the network rules again.
 * Concurrent first uses share one opening. A call that fails with
 * `SourceUnreachableError` retires the pool, so the next one connects afresh
 * (to a new address after a failover, say).
 */
export const withSourceConnection = async <T>(
  sourceId: string,
  fn: (conn: SourceConnection) => Promise<T>
): Promise<T> => {
  if (stopping) {
    throw new ServiceUnavailableError("The service is shutting down");
  }
  let row = await db.sources.findById(sourceId);
  // A row read before a change this process has already seen (a settings
  // change that just closed the pool, say) must not open a pool: read again.
  if (row && isOlderThanSeen(row)) {
    row = await db.sources.findById(sourceId);
  }
  if (row) noteSeen(sourceId, row.updatedAt);
  // Shutdown may have closed every pool while the row was read.
  if (stopping) {
    throw new ServiceUnavailableError("The service is shutting down");
  }
  if (!row || row.archivedAt) {
    const stale = entries.get(sourceId);
    if (stale) await retire(sourceId, stale);
    if (!row) throw new NotFoundError("Source not found");
    throw new SourceArchivedError();
  }
  const entry = acquire(row);
  try {
    return await fn(await entry.connection);
  } catch (err) {
    if (err instanceof SourceUnreachableError) void retire(sourceId, entry);
    throw err;
  } finally {
    await release(sourceId, entry);
  }
};

/**
 * Closes the source's pool; calls still running on it finish first.
 * `updatedAt` is the row's after the change that closes it: a call holding
 * an older row then reads the row again before opening another pool.
 */
export const closeSourcePool = async (
  sourceId: string,
  updatedAt?: Date
): Promise<void> => {
  if (updatedAt) noteSeen(sourceId, updatedAt);
  const entry = entries.get(sourceId);
  if (entry) await retire(sourceId, entry);
};

/**
 * Closes every pool, and waits up to `drainMs` for calls still running on any
 * of them to finish and their pools to close. Past that it returns: the pools
 * left are told to end, which each does once its running calls release their
 * connections, unless the process exits first.
 */
export const closeAllSourcePools = async (
  drainMs = POOL_DRAIN_MS
): Promise<void> => {
  await Promise.all([...entries].map(([id, entry]) => retire(id, entry)));
  let timer: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    Promise.all([...draining].map((entry) => entry.drained)).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), drainMs);
    }),
  ]);
  clearTimeout(timer);
  if (drained) return;
  logger.warn(
    { pools: draining.size },
    "source calls still running after the drain time; closing their pools"
  );
  // A pool ends only once its checked-out clients are released, so this only
  // asks; it does not stop the calls.
  for (const entry of draining) {
    void closeEntry(entry.sourceId, entry);
  }
};

/** For shutdown: refuses every later call, then closes every pool, waiting up to `drainMs` for running calls. */
export const stopSourcePools = async (
  drainMs = POOL_DRAIN_MS
): Promise<void> => {
  stopping = true;
  await closeAllSourcePools(drainMs);
};

export const isSourcePoolOpen = (sourceId: string): boolean =>
  entries.has(sourceId);
