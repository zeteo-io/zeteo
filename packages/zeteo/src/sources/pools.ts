import type { Source } from "../../prisma/generated/client/index.js";
import type { SourceConnection } from "../adapters/types.js";
import { connectChecked, readSettings } from "./connect.js";
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

interface Entry {
  connection: Promise<SourceConnection>;
  /** Which sealed settings the pool was opened with. */
  fingerprint: string;
  /** Calls running on this pool. */
  active: number;
  /** Taken out of the map: closes once the last running call ends. */
  retired: boolean;
  /** Opening failed: nothing to close. */
  failed: boolean;
  idleTimer?: NodeJS.Timeout;
  /** Settles once a retired entry with running calls has closed. */
  drained?: Promise<void>;
  onDrained?: () => void;
}

const entries = new Map<string, Entry>();
/** Retired entries whose calls are still running. */
const draining = new Set<Entry>();
let stopping = false;

// A settings change seals with a fresh IV and data key, so these two change
// whenever the settings do, on whichever replica made the change.
const fingerprintOf = (sealed: unknown): string => {
  const { iv, wrappedKey } = (sealed ?? {}) as {
    iv?: unknown;
    wrappedKey?: unknown;
  };
  return JSON.stringify([iv, wrappedKey]);
};

const openConnection = (row: Source): Promise<SourceConnection> => {
  const adapter = adapterFor(typeOf(row));
  return connectChecked(
    adapter,
    readSettings(adapter, row.id, row.sealedSettings)
  );
};

const closeEntry = async (sourceId: string, entry: Entry): Promise<void> => {
  if (entry.failed) return;
  try {
    await (await entry.connection).close();
  } catch (err) {
    logger.warn({ err, source_id: sourceId }, "closing a source pool failed");
  }
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
  const fingerprint = fingerprintOf(row.sealedSettings);
  let entry = entries.get(row.id);
  if (entry && entry.fingerprint !== fingerprint) {
    void retire(row.id, entry);
    entry = undefined;
  }
  if (!entry) {
    const created: Entry = {
      connection: openConnection(row),
      fingerprint,
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
 * Runs `fn` on the source's pool, opening it on first use. Every call reads
 * the source's row: a pool opened with other settings than the row now holds
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
  const row = await db.sources.findById(sourceId);
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

/** Closes the source's pool; calls still running on it finish first. */
export const closeSourcePool = async (sourceId: string): Promise<void> => {
  const entry = entries.get(sourceId);
  if (entry) await retire(sourceId, entry);
};

/** Closes every pool, and waits for calls still running on any of them to finish and their pools to close. */
export const closeAllSourcePools = async (): Promise<void> => {
  await Promise.all([...entries].map(([id, entry]) => retire(id, entry)));
  await Promise.all([...draining].map((entry) => entry.drained));
};

/** For shutdown: refuses every later call, then closes every pool. */
export const stopSourcePools = async (): Promise<void> => {
  stopping = true;
  await closeAllSourcePools();
};

export const isSourcePoolOpen = (sourceId: string): boolean =>
  entries.has(sourceId);
