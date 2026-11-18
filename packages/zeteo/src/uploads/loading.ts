import { withAudit, type Audit } from "../utils/transaction.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import type { PreviewTable, StagedTable } from "./staging.js";
import { readStagingRows, storedBytes } from "./storage.js";
import type { Prisma } from "../utils/db/prisma.js";
import type { UploadColumnType } from "./types.js";
import { normalizeName } from "./parse/names.js";
import { TypeInferrer } from "./parse/infer.js";
import { setTimeout } from "timers/promises";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import { randomUUID } from "crypto";
import env from "../env.js";
import {
  UploadSourceBusyError,
  isDatabaseBusy,
  QuotaExceededError,
  ValidationError,
} from "../utils/errors.js";
import {
  CastFailedError,
  dropLoadedTable,
  dropStaleLoads,
  loadTypedTable,
} from "./storage.js";

/**
 * Loading an upload source's tables: planning a table from a staging and the
 * caller's corrections, building the typed copies, and swapping them in with
 * the catalogue change in one transaction. Every load of a source runs under
 * its Redis lock (`withLoadLock`).
 */

/**
 * The waits of a load. Mutable so a test can shorten them.
 * - `lockWaitMs`: how long a load waits for another load of the source to
 *   release its Redis lock before answering `upload_source_busy`.
 * - `lockSeconds`: the Redis lock's expiry, past the longest load.
 * - `swapLockTimeoutMs`: the swap's `lock_timeout`; dropping a table waits for
 *   the queries reading it, and a swap kept waiting longer gives up.
 * - `swapTimeoutMs`: the whole swap transaction's bound.
 */
export const LOAD_LOCKING = {
  lockWaitMs: 10_000,
  lockSeconds: 15 * 60,
  swapLockTimeoutMs: 10_000,
  swapTimeoutMs: 60_000,
};

const LOCK_POLL_MS = 200;
/** Staged rows read at a time when inferring types again. */
const INFER_BATCH_ROWS = 5000;

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The Postgres type a catalogue row records for each column type. */
export const NATIVE_TYPE: Record<UploadColumnType, string> = {
  text: "text",
  number: "numeric",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp with time zone",
};

export const UPLOAD_COLUMN_TYPES: readonly UploadColumnType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
];

export const isUploadColumnType = (type: string): type is UploadColumnType =>
  (UPLOAD_COLUMN_TYPES as readonly string[]).includes(type);

const lockKey = (sourceId: string) => `zeteo:upload-source-load:${sourceId}`;
// Deletes the lock only while it is still this holder's.
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;

/**
 * Runs `fn` holding the source's load lock, after dropping the loads a crash
 * or a failed swap left behind (none of the source's loads is in flight
 * while the lock is held). Waits up to `lockWaitMs` for the lock, then
 * answers `UploadSourceBusyError`.
 */
export const withLoadLock = async <T>(
  sourceId: string,
  fn: () => Promise<T>
): Promise<T> => {
  const token = randomUUID();
  const deadline = Date.now() + LOAD_LOCKING.lockWaitMs;
  for (;;) {
    const got = await withinRedisTimeout(
      redis.set(lockKey(sourceId), token, "EX", LOAD_LOCKING.lockSeconds, "NX")
    );
    if (got === "OK") break;
    if (Date.now() >= deadline) throw new UploadSourceBusyError();
    await setTimeout(LOCK_POLL_MS);
  }
  try {
    await dropStaleLoads(sourceId);
    return await fn();
  } finally {
    await withinRedisTimeout(
      redis.eval(RELEASE, 1, lockKey(sourceId), token)
    ).catch((err: unknown) => {
      logger.warn({ err, source_id: sourceId }, "releasing a load lock failed");
    });
  }
};

export interface PlannedColumn {
  /** The column of the staging table (of the file). */
  index: number;
  name: string;
  originalName: string;
  type: UploadColumnType;
  /** Whether the caller set the type, so a re-upload keeps it over the column's own. */
  typeGiven: boolean;
}

export interface PlannedTable {
  name: string;
  stagingTable: string;
  /** The 0-based header row, null when there is none. */
  headerRow: number | null;
  columns: PlannedColumn[];
}

export interface TableCorrection {
  key: string;
  name?: string;
  header_row?: number | null;
  columns?: { index: number; name?: string; type?: UploadColumnType }[];
}

export interface StagingRecord {
  preview: PreviewTable[];
  tables: StagedTable[];
}

const invalid = (path: string, message: string) =>
  new ValidationError(`Invalid request body. ${path}: ${message}`, [
    { path, message },
  ]);

/** A table name a load may use: normalized, and never shaped like a load. */
export const checkTableName = (name: string, path: string): string => {
  if (!NAME.test(name)) {
    throw invalid(
      path,
      "A name is a lowercase letter, then lowercase letters, digits or _, at most 63"
    );
  }
  if (name.includes("__load_")) {
    throw invalid(path, "A table name cannot contain __load_");
  }
  return name;
};

/**
 * The columns of a staged table read with `headerRow` as its header, as the
 * preview would have proposed them: names from that row, and types inferred
 * from the rows below it for the columns in `infer` (text for the others,
 * which the caller types itself).
 */
const reread = async (
  staged: StagedTable,
  headerRow: number | null,
  infer: Set<number>
): Promise<Omit<PlannedColumn, "typeGiven">[]> => {
  const indexes = Array.from({ length: staged.columnCount }, (_, i) => i);
  const header =
    headerRow === null
      ? null
      : ((
          await readStagingRows(staged.stagingTable, headerRow, 1, indexes)
        )[0] ?? null);
  const inferred = [...infer].sort((a, b) => a - b);
  const inferrers = new Map(inferred.map((i) => [i, new TypeInferrer()]));
  if (inferred.length > 0) {
    let from = headerRow === null ? 0 : headerRow + 1;
    for (;;) {
      const rows = await readStagingRows(
        staged.stagingTable,
        from,
        INFER_BATCH_ROWS,
        inferred
      );
      for (const row of rows) {
        row.forEach((cell, i) => inferrers.get(inferred[i]!)!.add(cell));
      }
      if (rows.length < INFER_BATCH_ROWS) break;
      from += INFER_BATCH_ROWS;
    }
  }
  const taken = new Set<string>();
  return indexes.map((index) => {
    const raw = header === null ? "" : (header[index] ?? "");
    const name = normalizeName(raw, taken, index);
    return {
      index,
      name,
      originalName: header === null ? name : raw,
      type: inferrers.get(index)?.type ?? "text",
    };
  });
};

/**
 * The table `correction` makes of a staging: the preview's proposal with the
 * caller's header row, names and types. A header row other than the
 * preview's names the columns from that row and infers again the types the
 * caller did not set. `fixedName` is the table's name when it is not the
 * caller's to choose (a re-upload). `path` prefixes the 400s' paths.
 */
export const planTable = async (
  staging: StagingRecord,
  correction: TableCorrection,
  path: string,
  fixedName?: string
): Promise<PlannedTable> => {
  const preview = staging.preview.find((t) => t.key === correction.key);
  const staged = staging.tables.find((t) => t.key === correction.key);
  if (!preview || !staged) {
    throw invalid(`${path}.key`, "The upload has no table of this key");
  }
  const headerRow =
    correction.header_row === undefined
      ? preview.header_row
      : correction.header_row;
  if (headerRow !== null && headerRow >= staged.rowCount) {
    throw invalid(`${path}.header_row`, "The table has no such row");
  }

  const given = new Map<number, { name?: string; type?: UploadColumnType }>();
  for (const [i, c] of (correction.columns ?? []).entries()) {
    if (c.index >= staged.columnCount) {
      throw invalid(
        `${path}.columns.${i}.index`,
        "The table has no such column"
      );
    }
    if (given.has(c.index)) {
      throw invalid(`${path}.columns.${i}.index`, "A column is given twice");
    }
    given.set(c.index, c);
  }

  const base =
    headerRow === preview.header_row
      ? preview.columns.map((c) => ({
          index: c.index,
          name: c.name,
          originalName: c.original_name,
          type: c.type,
        }))
      : await reread(
          staged,
          headerRow,
          new Set(
            Array.from({ length: staged.columnCount }, (_, i) => i).filter(
              (i) => given.get(i)?.type === undefined
            )
          )
        );
  const columns = base.map((c) => {
    const fix = given.get(c.index);
    return {
      ...c,
      name: fix?.name ?? c.name,
      type: fix?.type ?? c.type,
      typeGiven: fix?.type !== undefined,
    };
  });
  const names = new Set<string>();
  for (const c of columns) {
    if (names.has(c.name)) {
      throw invalid(`${path}.columns`, `Two columns are named "${c.name}"`);
    }
    names.add(c.name);
  }

  const name = checkTableName(
    fixedName ?? correction.name ?? preview.name,
    `${path}.name`
  );
  return {
    name,
    stagingTable: staged.stagingTable,
    headerRow,
    columns,
  };
};

export interface Loaded {
  name: string;
  physicalName: string;
  rowCount: number;
}

/** Drops loads that will not be swapped in; a failure is logged, never thrown. */
const dropLoads = async (sourceId: string, loaded: Loaded[]) => {
  for (const l of loaded) {
    await dropLoadedTable(sourceId, l.physicalName).catch((err: unknown) => {
      logger.error(
        { err, source_id: sourceId, table: l.physicalName },
        "dropping a load that was not swapped in failed"
      );
    });
  }
};

/**
 * Builds the typed copy of each planned table. A value that does not cast
 * fails with `cast_failed` naming the table; the loads made so far are dropped.
 */
export const loadTables = async (
  sourceId: string,
  planned: PlannedTable[]
): Promise<Loaded[]> => {
  const loaded: Loaded[] = [];
  try {
    for (const t of planned) {
      try {
        const result = await loadTypedTable(sourceId, t.stagingTable, {
          name: t.name,
          headerRow: t.headerRow,
          columns: t.columns.map((c) => ({
            index: c.index,
            name: c.name,
            type: c.type,
          })),
        });
        loaded.push({ name: t.name, ...result });
      } catch (err) {
        if (err instanceof CastFailedError) {
          throw new CastFailedError(err.column, err.rows, t.name);
        }
        throw err;
      }
    }
  } catch (err) {
    await dropLoads(sourceId, loaded);
    throw err;
  }
  return loaded;
};

/**
 * Refuses (`quota_exceeded`) when the owner's stored upload source data, as `tx`
 * sees it, is over the quota. It first takes the owner's quota lock, a
 * transaction-scoped advisory lock: the check and the commit of every change
 * that adds to an owner's data (whatever the source, whoever acts) take turns,
 * so two changes cannot each pass on the other's uncommitted bytes. Its wait
 * is bounded by the transaction's `lock_timeout`.
 */
export const checkQuota = async (
  tx: Prisma.TransactionClient,
  ownerId: string
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zeteo:upload-quota:${ownerId}`}, 0))`;
  if ((await storedBytes(ownerId, tx)) > env.UPLOAD_QUOTA_BYTES) {
    throw new QuotaExceededError(env.UPLOAD_QUOTA_BYTES);
  }
};

/**
 * Runs `fn`, which swaps `loaded` in and changes the catalogue, in one audited
 * transaction whose lock waits end after `swapLockTimeoutMs`. If it fails, the
 * loads are dropped and nothing has changed; a lock wait or the transaction
 * running out of time answers `UploadSourceBusyError`.
 */
export const inSwap = async <T>(
  sourceId: string,
  loaded: Loaded[],
  fn: (tx: Prisma.TransactionClient, audit: Audit) => Promise<T>
): Promise<T> => {
  try {
    return await withAudit(
      async (tx, audit) => {
        // SET takes no parameters; the value is a number of this module's.
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = ${Math.floor(LOAD_LOCKING.swapLockTimeoutMs)}`
        );
        return fn(tx, audit);
      },
      { timeoutMs: LOAD_LOCKING.swapTimeoutMs }
    );
  } catch (err) {
    await dropLoads(sourceId, loaded);
    if (isDatabaseBusy(err)) throw new UploadSourceBusyError();
    throw err;
  }
};
