import { Prisma as PrismaRuntime } from "../../prisma/generated/client/index.js";
import { dropStagingTables, stageTable, toUnreadable } from "./staging.js";
import { dropStoredTable, CastFailedError, swapIn } from "./storage.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { readSpreadsheet } from "../google/sheets.js";
import { isSheetsSource } from "../sources/types.js";
import { prisma } from "../utils/db/prisma.js";
import { logger } from "../utils/logger.js";
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
  SourceArchivedError,
  TooManyRequestsError,
  UploadSourceBusyError,
} from "../utils/errors.js";
import {
  assertUploadsOn,
  matchColumns,
  writeColumns,
  type ColumnMatches,
} from "./service.js";
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
 * Syncing a Google Sheets source: every table read again from its tab, each
 * loaded as a re-upload would be (columns matched to the sheet's headers),
 * and all swapped in at once. A sync that fails changes no table; its error
 * is kept on the source for its owner to see. Syncs are logged, not audited.
 */

export interface SyncSummary {
  synced_at: string;
  tables: { id: string; name: string; row_count: number; missing: boolean }[];
}

/** How long after a Sync now the source refuses another. */
export const SYNC_NOW_SECONDS = 60;

const syncNowKey = (sourceId: string) => `zeteo:sync-now:${sourceId}`;

/**
 * Where a table's data is in its spreadsheet, as `vendor_locator` keeps it.
 * Create and add-tables always set it; one without a header row is read with
 * row 0 as its header, and one naming no tab fails the sync rather than
 * losing the table.
 */
const locatorOf = (table: SourceTable) => {
  const locator = table.vendorLocator as {
    sheetId?: unknown;
    headerRow?: unknown;
  } | null;
  if (typeof locator?.sheetId !== "number") {
    logger.error(
      { source_id: table.sourceId, table_id: table.id },
      "a Sheets table has no tab in its locator"
    );
    throw new Error("A Sheets table has no tab in its locator");
  }
  if (typeof locator.headerRow !== "number" && locator.headerRow !== null) {
    logger.warn(
      { source_id: table.sourceId, table_id: table.id },
      "a Sheets table has no header row in its locator; reading row 0 as its header"
    );
    return { sheetId: locator.sheetId, headerRow: 0 };
  }
  return { sheetId: locator.sheetId, headerRow: locator.headerRow };
};

/** What a failed sync keeps on the source: the error's code, and a message for the owner. */
const syncErrorOf = (err: unknown): { code: string; message: string } => {
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

/** Records a failed sync on the source in its own write; a failure to record is logged. */
const recordFailure = async (sourceId: string, err: unknown) => {
  const error = syncErrorOf(err);
  logger.warn(
    { source_id: sourceId, code: error.code },
    "a Google Sheets sync failed"
  );
  await prisma.source
    .update({
      where: { id: sourceId },
      data: { lastSyncAttemptAt: new Date(), lastSyncError: error },
    })
    .catch((recordErr: unknown) => {
      logger.error(
        { err: recordErr, source_id: sourceId },
        "recording a failed sync failed"
      );
    });
};

/** The source row a sync starts from: 404 for none, 409 for another type or an archived one. */
const sheetsSource = async (sourceId: string) => {
  const row = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!row) throw new NotFoundError("Source not found");
  if (!isSheetsSource(row)) throw new NotASheetsSourceError();
  if (row.archivedAt) throw new SourceArchivedError();
  return row;
};

interface TableSync {
  table: SourceTable;
  planned: PlannedTable;
  columns: ColumnMatches;
  /** A missing table whose tab is back: it is no longer missing once swapped in. */
  revived: boolean;
}

type CatalogTable = SourceTable & { columns: SourceColumn[] };

/**
 * The sheetId a missing table's locator names, or null for none (never
 * thrown) and for a table its owner removed, which a sync never brings back.
 */
const missingSheetId = (table: SourceTable): number | null => {
  const locator = table.vendorLocator as {
    sheetId?: unknown;
    removed?: unknown;
  } | null;
  if (locator?.removed === true) return null;
  return typeof locator?.sheetId === "number" ? locator.sheetId : null;
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

/**
 * Reads the source's spreadsheet and stages and plans each live table, and
 * each missing table whose tab is back (`revivable`). A live table whose tab
 * is gone is in `gone`; a missing one whose tab is still gone, or empty, stays
 * as it is. Staging tables made go in `created`.
 */
const readTables = async (
  spreadsheetId: string,
  live: CatalogTable[],
  missing: CatalogTable[],
  created: string[]
): Promise<{ syncs: TableSync[]; gone: SourceTable[] }> => {
  const located = [
    ...live.map((table) => ({
      table,
      locator: locatorOf(table),
      revived: false,
    })),
    ...revivable(live, missing).map((table) => ({
      table,
      locator: locatorOf(table),
      revived: true,
    })),
  ];
  const read = await readSpreadsheet(
    spreadsheetId,
    { maxRows: env.UPLOAD_MAX_ROWS, maxColumns: env.UPLOAD_MAX_COLUMNS },
    located.map((l) => l.locator.sheetId)
  );
  const tabs = new Map(read.tabs.map((t) => [t.sheetId, t]));
  const syncs: TableSync[] = [];
  const gone: SourceTable[] = [];
  for (const { table, locator, revived } of located) {
    const tab = tabs.get(locator.sheetId);
    if (!tab) {
      if (!revived) gone.push(table);
      continue;
    }
    const key = `sheet:${locator.sheetId}`;
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
      if (revived) continue;
      throw new FileUnreadableError(
        "empty_file",
        `The tab of table "${table.name}" has no data; the last synced data is kept`
      );
    }
    const staging: StagingRecord = {
      preview: [staged.preview],
      tables: [staged.staged],
    };
    const planned = await planTable(
      staging,
      { key, header_row: locator.headerRow },
      "",
      table.name
    );
    syncs.push({
      table,
      planned,
      columns: matchColumns(table.columns, planned.columns, "original_name"),
      revived,
    });
  }
  return { syncs, gone };
};

const sync = async (
  sourceId: string,
  spreadsheetId: string,
  actorId: string
): Promise<SyncSummary> => {
  // Under the load lock nothing else changes the tables' data or columns.
  const tables = await prisma.sourceTable.findMany({
    where: { sourceId },
    include: { columns: { orderBy: { position: "asc" } } },
    orderBy: { name: "asc" },
  });
  const created: string[] = [];
  try {
    let read: Awaited<ReturnType<typeof readTables>>;
    try {
      read = await readTables(
        spreadsheetId,
        tables.filter((t) => t.missingSince === null),
        tables.filter((t) => t.missingSince !== null),
        created
      );
    } catch (err) {
      throw toUnreadable(err);
    }
    const { syncs, gone } = read;
    const loaded = await loadTables(
      sourceId,
      syncs.map((s) => s.planned)
    );
    const now = new Date();
    await inSwap(sourceId, loaded, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "zeteo"."sources" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
      const row = await tx.source.findUniqueOrThrow({
        where: { id: sourceId },
      });
      if (row.archivedAt) throw new SourceArchivedError();
      for (const [i, s] of syncs.entries()) {
        await swapIn(tx, sourceId, s.planned.name, loaded[i]!.physicalName);
        await writeColumns(tx, s.table.id, s.planned.columns, s.columns, now);
        await tx.sourceTable.update({
          where: { id: s.table.id },
          data: {
            rowCount: loaded[i]!.rowCount,
            lastSyncedAt: now,
            lastSeenAt: now,
            ...(s.revived && { missingSince: null }),
          },
        });
      }
      for (const table of gone) {
        await dropStoredTable(tx, sourceId, table.name);
        await tx.sourceTable.update({
          where: { id: table.id },
          data: { missingSince: now },
        });
        await tx.sourceColumn.updateMany({
          where: { tableId: table.id, missingSince: null },
          data: { missingSince: now },
        });
      }
      await checkQuota(tx, row.ownerId!);
      await tx.source.update({
        where: { id: sourceId },
        data: {
          status: "active",
          lastRefreshedAt: now,
          lastSyncAttemptAt: now,
          lastSyncError: PrismaRuntime.DbNull,
        },
      });
    });
    logger.info(
      {
        source_id: sourceId,
        actor_id: actorId,
        tables: syncs.length,
        revived: syncs.filter((s) => s.revived).length,
        missing: gone.length,
      },
      "a Google Sheets source synced"
    );
    return {
      synced_at: now.toISOString(),
      tables: [
        ...syncs.map((s, i) => ({
          id: s.table.id,
          name: s.table.name,
          row_count: loaded[i]!.rowCount,
          missing: false,
        })),
        ...gone.map((t) => ({
          id: t.id,
          name: t.name,
          row_count: Number(t.rowCount ?? 0),
          missing: true,
        })),
      ],
    };
  } finally {
    await dropStagingTables(created);
  }
};

/**
 * Syncs a Google Sheets source under its load lock: reads every tab backing a
 * table that is not missing (and brings back a missing table whose tab has
 * returned, keeping its id and grants), loads each table again (columns matched to the
 * sheet's headers by `original_name`, keeping their ids, grants and types;
 * new headers added, removed ones marked missing), marks missing the tables
 * whose tab is gone, and swaps everything in in one transaction that checks
 * the owner's quota. On any failure nothing is swapped; the error is kept on
 * the source (`last_sync_error`, with the attempt's time) and thrown.
 */
export const syncSheetsSource = async (
  sourceId: string,
  actorId: string
): Promise<SyncSummary> => {
  await sheetsSource(sourceId);
  assertUploadsOn();
  return withLoadLock(sourceId, async () => {
    // Read again under the lock: a delete may have landed while it waited.
    const row = await sheetsSource(sourceId);
    try {
      return await sync(sourceId, row.vendorFileId!, actorId);
    } catch (err) {
      // Busy (a swap kept waiting) is not a failure of the sync: nothing was
      // read wrong, and the next sync will do.
      if (!(err instanceof UploadSourceBusyError)) {
        await recordFailure(sourceId, err);
      }
      throw err;
    }
  });
};

/**
 * Sync now: a sync the caller asked for, refused with 429 `sync_too_soon`
 * within `SYNC_NOW_SECONDS` of the last one asked for the source (one refused
 * as `upload_source_busy` does not count). Call it only for a caller already
 * allowed to sync the source.
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
    return await syncSheetsSource(sourceId, actorId);
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
