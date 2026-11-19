import { Prisma as PrismaRuntime } from "../../prisma/generated/client/index.js";
import { dropStagingTables, stageTable, toUnreadable } from "./staging.js";
import { readSpreadsheet, type SpreadsheetTab } from "../google/sheets.js";
import { assertUploadsOn, matchColumns, writeColumns } from "./service.js";
import { dropStoredTable, CastFailedError, swapIn } from "./storage.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import { originOf, type SheetsOrigin } from "./origin.js";
import { isUploadSource } from "../sources/types.js";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { redis } from "../utils/redis.js";
import env from "../env.js";
import type {
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";
import {
  AppError,
  FileUnreadableError,
  NotASheetsSourceError,
  NotFoundError,
  NothingToSyncError,
  SourceArchivedError,
  TooManyRequestsError,
  UploadSourceBusyError,
} from "../utils/errors.js";
import {
  checkQuota,
  inSwap,
  loadTables,
  planTable,
  withLoadLock,
  type PlannedTable,
  type StagingRecord,
} from "./loading.js";

/**
 * Syncing an upload source's Google Sheets tables: each spreadsheet read once,
 * then each table loaded as a re-upload would be (columns matched to the
 * sheet's headers) and swapped in in its own transaction. A table that fails
 * (its spreadsheet unshared, a value that no longer casts, an emptied tab)
 * keeps its data and its error, which its owner sees; the others sync. Syncs
 * are logged, not audited.
 */

/** Why a table's sync failed, as its owner sees it. */
export interface TableSyncError {
  code: string;
  message: string;
}

export interface SyncSummary {
  synced_at: string;
  tables: {
    id: string;
    name: string;
    row_count: number;
    missing: boolean;
    error: TableSyncError | null;
  }[];
}

/** How long after a Sync now the source refuses another. */
export const SYNC_NOW_SECONDS = 60;

const syncNowKey = (sourceId: string) => `zeteo:sync-now:${sourceId}`;

/** A Sheets table's origin: where its data is in its spreadsheet, or null for another table. */
const sheetsOriginOf = (table: { origin: unknown }): SheetsOrigin | null => {
  const origin = originOf(table);
  return origin?.kind === "google-sheets" ? origin : null;
};

/**
 * Where a Sheets table's data is in its spreadsheet, as its origin keeps it.
 * Only called for a table whose origin is a Sheets tab.
 */
const locatorOf = (table: SourceTable) => {
  const origin = sheetsOriginOf(table)!;
  return { sheetId: origin.sheetId, headerRow: origin.headerRow };
};

/** What a failed table sync keeps on the table: the error's code, and a message for the owner. */
const syncErrorOf = (err: unknown): TableSyncError => {
  if (err instanceof CastFailedError) {
    const rows = err.rows.join(", ");
    return {
      code: err.code,
      message: `${err.message} (${err.rows.length === 1 ? "row" : "rows"} ${rows})`,
    };
  }
  if (err instanceof AppError) return { code: err.code, message: err.message };
  return { code: "sync_failed", message: "The sync failed" };
};

/** Records a table's failed sync on the table in its own write; a failure to record is logged. */
const recordTableFailure = async (
  table: SourceTable,
  error: TableSyncError,
  at: Date
) => {
  logger.warn(
    { source_id: table.sourceId, table_id: table.id, code: error.code },
    "a Google Sheets table's sync failed"
  );
  await prisma.sourceTable
    .update({
      where: { id: table.id },
      data: { lastSyncAttemptAt: at, lastSyncError: { ...error } },
    })
    .catch((recordErr: unknown) => {
      logger.error(
        { err: recordErr, source_id: table.sourceId, table_id: table.id },
        "recording a failed table sync failed"
      );
    });
};

/**
 * The source row a sync starts from: 404 for none, 409 for a database source
 * (`not_a_sheets_source`), an archived one, or an upload source with no
 * Google Sheets table, live or missing (`nothing_to_sync`).
 */
const sheetsSource = async (sourceId: string) => {
  const row = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!row) throw new NotFoundError("Source not found");
  if (!isUploadSource(row)) throw new NotASheetsSourceError();
  if (row.archivedAt) throw new SourceArchivedError();
  if (!(await db.sources.hasSheetsTables(sourceId))) {
    throw new NothingToSyncError();
  }
  return row;
};

type CatalogTable = SourceTable & { columns: SourceColumn[] };

/**
 * The sheetId a missing table's locator names, or null for none (never
 * thrown) and for a table its owner removed, which a sync never brings back.
 */
const missingSheetId = (table: SourceTable): number | null => {
  const origin = sheetsOriginOf(table);
  if (!origin || origin.removed === true) return null;
  return origin.sheetId;
};

/**
 * The missing tables a sync may bring back: those whose locator names a tab
 * no live table reads (never one the owner removed), the most recently
 * missing one per tab. (Sheets keeps a
 * tab's sheetId when a deletion is undone.)
 */
const revivable = (live: CatalogTable[], missing: CatalogTable[]) => {
  const claimed = new Set(live.map((t) => locatorOf(t).sheetId));
  const latest = new Map<number, CatalogTable>();
  for (const table of missing) {
    const sheetId = missingSheetId(table);
    if (sheetId === null || claimed.has(sheetId)) continue;
    const held = latest.get(sheetId);
    if (!held || held.missingSince! < table.missingSince!) {
      latest.set(sheetId, table);
    }
  }
  return [...latest.values()];
};

/** The source's Sheets tables (not those their owner removed), by the spreadsheet they come from. */
const bySpreadsheet = (tables: CatalogTable[]) => {
  const groups = new Map<string, CatalogTable[]>();
  for (const table of tables) {
    const origin = sheetsOriginOf(table);
    if (!origin || origin.removed === true) continue;
    const group = groups.get(origin.spreadsheetId) ?? [];
    group.push(table);
    groups.set(origin.spreadsheetId, group);
  }
  return groups;
};

/** What a sync did to one table. */
type Outcome =
  | { table: SourceTable; kind: "synced"; rowCount: number }
  | { table: SourceTable; kind: "missing" }
  | { table: SourceTable; kind: "failed"; err: unknown; error: TableSyncError };

/**
 * A failure that stops the whole sync rather than one table: the swap kept
 * waiting (busy, not the sync's fault) or the source archived meanwhile.
 */
const stopsTheSync = (err: unknown) =>
  err instanceof UploadSourceBusyError || err instanceof SourceArchivedError;

/**
 * Stages, plans, loads and swaps in one table from its tab, in its own
 * transaction that checks the owner's quota. Null when a missing table's tab
 * turns out empty (it stays missing); a live table's empty tab fails.
 */
const syncTable = async (
  sourceId: string,
  table: CatalogTable,
  tab: SpreadsheetTab,
  revived: boolean,
  spreadsheetTitle: string,
  now: Date
): Promise<number | null> => {
  const locator = locatorOf(table);
  const key = `sheet:${locator.sheetId}`;
  const created: string[] = [];
  try {
    let planned: PlannedTable;
    try {
      const staged = await stageTable(
        tab.rows,
        {
          key,
          fallbackName: table.name,
          kind: "sheet",
          trimUnusedColumns: true,
        },
        new Set(),
        created
      );
      if (
        !staged ||
        (locator.headerRow !== null &&
          locator.headerRow >= staged.staged.rowCount)
      ) {
        if (revived) return null;
        throw new FileUnreadableError(
          "empty_file",
          `The tab of table "${table.name}" has no data; the last synced data is kept`
        );
      }
      const staging: StagingRecord = {
        preview: [staged.preview],
        tables: [staged.staged],
      };
      planned = await planTable(
        staging,
        { key, header_row: locator.headerRow },
        "",
        table.name
      );
    } catch (err) {
      throw toUnreadable(err);
    }
    const columns = matchColumns(
      table.columns,
      planned.columns,
      "original_name"
    );
    const loaded = await loadTables(sourceId, [planned]);
    const rowCount = loaded[0]!.rowCount;
    await inSwap(sourceId, loaded, [table.id], async (tx) => {
      const row = await lockSyncedSource(tx, sourceId);
      // The tab's and spreadsheet's current names, from the read.
      const current = await tx.sourceTable.findUniqueOrThrow({
        where: { id: table.id },
        select: { origin: true },
      });
      const origin = sheetsOriginOf(current);
      await swapIn(tx, sourceId, planned.name, loaded[0]!.physicalName);
      await writeColumns(tx, table.id, planned.columns, columns, now);
      await tx.sourceTable.update({
        where: { id: table.id },
        data: {
          rowCount,
          lastSyncedAt: now,
          lastSeenAt: now,
          lastSyncAttemptAt: now,
          lastSyncError: PrismaRuntime.DbNull,
          ...(origin && {
            origin: { ...origin, tabTitle: tab.name, spreadsheetTitle },
          }),
          ...(revived && { missingSince: null }),
        },
      });
      await checkQuota(tx, row.ownerId!);
    });
    return rowCount;
  } finally {
    await dropStagingTables(created);
  }
};

/** Locks the source's row for a swap; an archived source stops the sync. */
const lockSyncedSource = async (
  tx: Prisma.TransactionClient,
  sourceId: string
) => {
  await tx.$queryRaw`SELECT "id" FROM "zeteo"."sources" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
  const row = await tx.source.findUniqueOrThrow({ where: { id: sourceId } });
  if (row.archivedAt) throw new SourceArchivedError();
  return row;
};

/** Marks missing a table whose tab is gone, dropping its data, in its own transaction. */
const markGone = async (sourceId: string, table: SourceTable, now: Date) => {
  await inSwap(sourceId, [], [table.id], async (tx) => {
    await lockSyncedSource(tx, sourceId);
    await dropStoredTable(tx, sourceId, table.name);
    await tx.sourceTable.update({
      where: { id: table.id },
      data: {
        missingSince: now,
        lastSyncAttemptAt: now,
        lastSyncError: PrismaRuntime.DbNull,
      },
    });
    await tx.sourceColumn.updateMany({
      where: { tableId: table.id, missingSince: null },
      data: { missingSince: now },
    });
  });
};

/**
 * Syncs every table of one spreadsheet: one read, then each live table (and
 * each missing one whose tab is back) on its own. A read that fails fails
 * each of its live tables.
 */
const syncSpreadsheet = async (
  sourceId: string,
  spreadsheetId: string,
  group: CatalogTable[],
  now: Date
): Promise<Outcome[]> => {
  const live = group.filter((t) => t.missingSince === null);
  const missing = group.filter((t) => t.missingSince !== null);
  const located = [
    ...live.map((table) => ({ table, revived: false })),
    ...revivable(live, missing).map((table) => ({ table, revived: true })),
  ];
  // Recorded on the table at once, so a later stop (busy) keeps it.
  const failed = async (table: SourceTable, err: unknown): Promise<Outcome> => {
    const error = syncErrorOf(err);
    await recordTableFailure(table, error, now);
    return { table, kind: "failed", err, error };
  };
  let tabs: Map<number, SpreadsheetTab>;
  let spreadsheetTitle: string;
  try {
    const read = await readSpreadsheet(
      spreadsheetId,
      { maxRows: env.UPLOAD_MAX_ROWS, maxColumns: env.UPLOAD_MAX_COLUMNS },
      located.map((l) => locatorOf(l.table).sheetId)
    );
    tabs = new Map(read.tabs.map((t) => [t.sheetId, t]));
    spreadsheetTitle = read.title;
  } catch (err) {
    const unreadable = toUnreadable(err);
    const outcomes: Outcome[] = [];
    for (const table of live) outcomes.push(await failed(table, unreadable));
    return outcomes;
  }
  const outcomes: Outcome[] = [];
  for (const { table, revived } of located) {
    const tab = tabs.get(locatorOf(table).sheetId);
    try {
      if (!tab) {
        if (revived) continue;
        await markGone(sourceId, table, now);
        outcomes.push({ table, kind: "missing" });
        continue;
      }
      const rowCount = await syncTable(
        sourceId,
        table,
        tab,
        revived,
        spreadsheetTitle,
        now
      );
      if (rowCount !== null) outcomes.push({ table, kind: "synced", rowCount });
    } catch (err) {
      if (stopsTheSync(err)) throw err;
      // A missing table that cannot be brought back simply stays missing.
      if (revived) {
        logger.warn(
          { err, source_id: sourceId, table_id: table.id },
          "a missing Google Sheets table could not be brought back"
        );
        continue;
      }
      outcomes.push(await failed(table, err));
    }
  }
  return outcomes;
};

/**
 * Keeps the run on the source: when it was attempted, the failing tables
 * (null for none), and as its last refresh the oldest good sync among its
 * live Sheets tables (what a reader can trust; null while one has never
 * synced). Each failing table was recorded on the table as it failed.
 */
const recordRun = async (sourceId: string, outcomes: Outcome[], now: Date) => {
  const failing = outcomes.flatMap((o) =>
    o.kind === "failed"
      ? [{ table_id: o.table.id, name: o.table.name, ...o.error }]
      : []
  );
  const live = await prisma.sourceTable.findMany({
    where: { sourceId, missingSince: null },
    select: { origin: true, lastSyncedAt: true },
  });
  const synced = live
    .filter((t) => sheetsOriginOf(t) !== null)
    .map((t) => t.lastSyncedAt);
  // Null while a live Sheets table has never synced.
  const oldest = synced.includes(null)
    ? null
    : new Date(Math.min(...synced.map((d) => d!.getTime())));
  await prisma.source
    .update({
      where: { id: sourceId },
      data: {
        lastSyncAttemptAt: now,
        lastSyncError:
          failing.length > 0 ? { tables: failing } : PrismaRuntime.DbNull,
        ...(synced.length > 0 && { lastRefreshedAt: oldest }),
        ...(outcomes.some((o) => o.kind !== "failed") && {
          status: "active" as const,
        }),
      },
    })
    .catch((err: unknown) => {
      logger.error({ err, source_id: sourceId }, "recording a sync failed");
    });
};

const sync = async (
  sourceId: string,
  actorId: string
): Promise<SyncSummary> => {
  // Under the load lock nothing else changes the tables' data or columns.
  const tables = await prisma.sourceTable.findMany({
    where: { sourceId },
    include: { columns: { orderBy: { position: "asc" } } },
    orderBy: { name: "asc" },
  });
  const now = new Date();
  const outcomes: Outcome[] = [];
  for (const [spreadsheetId, group] of bySpreadsheet(tables)) {
    outcomes.push(
      ...(await syncSpreadsheet(sourceId, spreadsheetId, group, now))
    );
  }
  await recordRun(sourceId, outcomes, now);
  const failures = outcomes.filter((o) => o.kind === "failed");
  logger.info(
    {
      source_id: sourceId,
      actor_id: actorId,
      tables: outcomes.filter((o) => o.kind === "synced").length,
      revived: outcomes.filter(
        (o) => o.kind === "synced" && o.table.missingSince !== null
      ).length,
      missing: outcomes.filter((o) => o.kind === "missing").length,
      failed: failures.length,
    },
    "a Google Sheets source synced"
  );
  // Every table failed: the sync failed, with the first table's error.
  if (failures.length > 0 && failures.length === outcomes.length) {
    throw failures[0]!.err;
  }
  return {
    synced_at: now.toISOString(),
    tables: outcomes
      .map((o) => ({
        id: o.table.id,
        name: o.table.name,
        row_count:
          o.kind === "synced" ? o.rowCount : Number(o.table.rowCount ?? 0),
        missing: o.kind === "missing",
        error: o.kind === "failed" ? o.error : null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
};

/**
 * Syncs an upload source's Google Sheets tables under its load lock (its file
 * tables are left as they are). Each spreadsheet its tables come from is read
 * once; then each live table is loaded again (columns matched to the sheet's
 * headers by `original_name`, then name, keeping their ids, grants and types;
 * new headers added, removed ones marked missing) and swapped in in its own
 * transaction that checks the owner's quota; a missing table whose tab has
 * returned is brought back (keeping its id and grants), never one its owner
 * removed; a table whose tab is gone is marked missing. A table that fails
 * keeps its data, and its error (`last_sync_error`, with the attempt's time)
 * is kept on it; the source keeps the attempt's time and its failing tables.
 * When every table failed the first one's error is thrown; when some synced
 * the summary carries each one's error. A swap kept waiting
 * (`upload_source_busy`) stops the sync and is recorded nowhere.
 */
export const syncSource = async (
  sourceId: string,
  actorId: string
): Promise<SyncSummary> => {
  await sheetsSource(sourceId);
  assertUploadsOn();
  return withLoadLock(sourceId, async () => {
    // Read again under the lock: a delete may have landed while it waited.
    await sheetsSource(sourceId);
    return sync(sourceId, actorId);
  });
};

/**
 * Sync now: a sync the caller asked for, refused with 429 `sync_too_soon`
 * within `SYNC_NOW_SECONDS` of the last one asked for the source. A sync
 * stopped as `upload_source_busy` frees the window again, so the caller can
 * retry at once. `nothing_to_sync` is answered before the window is taken.
 * Call it only for a caller already allowed to sync the source.
 */
export const syncNow = async (
  sourceId: string,
  actorId: string
): Promise<SyncSummary> => {
  await sheetsSource(sourceId);
  assertUploadsOn();
  const key = syncNowKey(sourceId);
  const got = await withinRedisTimeout(
    redis.set(key, "1", "EX", SYNC_NOW_SECONDS, "NX")
  );
  if (got !== "OK") {
    const ttl = await withinRedisTimeout(redis.ttl(key));
    throw new TooManyRequestsError(
      Math.max(1, ttl),
      "This source was synced less than a minute ago; try again shortly",
      "sync_too_soon"
    );
  }
  try {
    return await syncSource(sourceId, actorId);
  } catch (err) {
    // Busy: nothing was synced, so the window is not used up.
    if (err instanceof UploadSourceBusyError) {
      await withinRedisTimeout(redis.del(key)).catch((delErr: unknown) => {
        logger.warn(
          { err: delErr, source_id: sourceId },
          "freeing the Sync now window failed"
        );
      });
    }
    throw err;
  }
};
