import { NotFoundError, SourceArchivedError } from "../utils/errors.js";
import type { SourceConnection } from "../adapters/types.js";
import { connectChecked, readSettings } from "./connect.js";
import { adapterFor } from "../adapters/index.js";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { typeOf } from "./types.js";

export const POOL_IDLE_MS = 5 * 60_000;

interface Entry {
  connection: Promise<SourceConnection>;
  /** Calls running on this pool. */
  active: number;
  /** Taken out of the map: closes once the last running call ends. */
  retired: boolean;
  /** Opening failed: nothing to close. */
  failed: boolean;
  idleTimer?: NodeJS.Timeout;
}

const entries = new Map<string, Entry>();

const openConnection = async (sourceId: string): Promise<SourceConnection> => {
  const row = await db.sources.findById(sourceId);
  if (!row) throw new NotFoundError("Source not found");
  if (row.archivedAt) throw new SourceArchivedError();
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
  entry.retired = true;
  if (entries.get(sourceId) === entry) entries.delete(sourceId);
  return entry.active === 0 ? closeEntry(sourceId, entry) : Promise.resolve();
};

const armIdleTimer = (sourceId: string, entry: Entry): void => {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void retire(sourceId, entry);
  }, POOL_IDLE_MS);
  // An idle pool must not keep the process alive.
  entry.idleTimer.unref();
};

const acquire = (sourceId: string): Entry => {
  let entry = entries.get(sourceId);
  if (!entry) {
    const created: Entry = {
      connection: openConnection(sourceId),
      active: 0,
      retired: false,
      failed: false,
    };
    // A pool that failed to open is not kept, so the next call tries again.
    created.connection.catch(() => {
      created.failed = true;
      if (entries.get(sourceId) === created) entries.delete(sourceId);
    });
    entries.set(sourceId, created);
    entry = created;
  }
  clearTimeout(entry.idleTimer);
  entry.active++;
  return entry;
};

const release = async (sourceId: string, entry: Entry): Promise<void> => {
  entry.active--;
  if (entry.active > 0) return;
  if (entry.retired) await closeEntry(sourceId, entry);
  else armIdleTimer(sourceId, entry);
};

/**
 * Runs `fn` on the source's pool, opening it on first use. Opening checks the
 * source's host against the network rules again. Concurrent first uses share
 * one opening.
 */
export const withSourceConnection = async <T>(
  sourceId: string,
  fn: (conn: SourceConnection) => Promise<T>
): Promise<T> => {
  const entry = acquire(sourceId);
  try {
    return await fn(await entry.connection);
  } finally {
    await release(sourceId, entry);
  }
};

/** Closes the source's pool; calls still running on it finish first. */
export const closeSourcePool = async (sourceId: string): Promise<void> => {
  const entry = entries.get(sourceId);
  if (entry) await retire(sourceId, entry);
};

export const closeAllSourcePools = async (): Promise<void> => {
  await Promise.all([...entries].map(([id, entry]) => retire(id, entry)));
};

export const isSourcePoolOpen = (sourceId: string): boolean =>
  entries.has(sourceId);
