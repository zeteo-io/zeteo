import { alreadyOwnerError, checkTransferTarget } from "../sharing/shares.js";
import { withAudit, type Audit } from "../utils/transaction.js";
import { toRow as toMeasureRow } from "../utils/db/measures.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { isUploadSource, typeOf } from "../sources/types.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import { discardStaging, getStaging } from "./staging.js";
import { presentSourceById } from "../sources/present.js";
import { lockSourceMeasures } from "../measures/lock.js";
import { tableRemoval } from "../measures/dependents.js";
import { hasPermission } from "../utils/permissions.js";
import { closeSourcePool } from "../sources/pools.js";
import { toMetricRow } from "../utils/db/metrics.js";
import type { SourceView } from "../views/source.js";
import type { Caller } from "../middleware/auth.js";
import type { UploadColumnType } from "./types.js";
import { normalizeName } from "./parse/names.js";
import type { Touched } from "./mergedViews.js";
import { logger } from "../utils/logger.js";
import { lacking } from "./ownership.js";
import { randomUUID } from "crypto";
import env from "../env.js";
import type {
  Source,
  SourceColumn,
} from "../../prisma/generated/client/index.js";
import {
  AUDIT_EVENTS,
  UPLOADS_WRITE,
  SOURCES_WRITE,
} from "../definitions/tereoDeclaration.js";
import {
  ConflictError,
  UploadSourceBusyError,
  UploadsNotConfiguredError,
  isDatabaseBusy,
  MeasureInUseError,
  NotAFileUploadError,
  NotAnUploadSourceError,
  NotFoundError,
  SourceArchivedError,
  TabAlreadyAddedError,
  TableInMergedTableError,
  ValidationError,
} from "../utils/errors.js";
import {
  checkQuota,
  inSwap,
  isUploadColumnType,
  loadTables,
  NATIVE_TYPE,
  planTable,
  withLoadLock,
  type Loaded,
  type PlannedColumn,
  type PlannedTable,
  type TableCorrection,
} from "./loading.js";
import {
  dropSourceSchema,
  dropStagingTable,
  dropStoredTable,
  schemaFor,
  stageStoredTable,
  swapIn,
} from "./storage.js";
import {
  isFileTable,
  isMergedTable,
  originOf,
  sheetOfKey,
  type TableOrigin,
} from "./origin.js";
import {
  assertSheetUnclaimed,
  claimSpreadsheet,
  releaseAllClaims,
  releaseUnusedClaims,
} from "./claims.js";

export { LOAD_LOCKING } from "./loading.js";

/**
 * Upload sources: create one from a staging, rename, delete, add, re-upload
 * and remove tables, change a column, transfer. The owner (holding
 * `zeteo.uploads.write`) changes their own; an admin changes any with
 * `zeteo.sources.write`; anyone else gets the 403 of a caller without that
 * permission (the routes refuse them first). A database source is
 * `not_an_upload_source`. Every change of data runs under the source's load
 * lock; audit entries name tables and columns, never a cell.
 */

const NOUN = "upload source";

/** The slug's shape, as `sources.slug`'s CHECK has it. */
const SLUG_MAX = 63;

const slugTaken = () =>
  new ConflictError("A source with this slug already exists", "name_taken");
export const tableNameTaken = () =>
  new ConflictError(
    "The source already has a table of this name",
    "name_taken"
  );
const columnNameTaken = () =>
  new ConflictError(
    "The table already has a column of this name",
    "name_taken"
  );

/** 404 `uploads_not_configured` while `UPLOADS_READER_URL` is unset. */
export const assertUploadsOn = (): void => {
  if (!env.UPLOADS_READER_URL) throw new UploadsNotConfiguredError();
};

/** Whether the caller may change the source: its owner with `zeteo.uploads.write`, or an admin. */
const mayChange = (caller: Caller, row: { ownerId: string | null }): boolean =>
  (row.ownerId === caller.userId &&
    hasPermission(caller.permissions, UPLOADS_WRITE)) ||
  hasPermission(caller.permissions, SOURCES_WRITE);

/** The checks on a source row an upload-only change makes, in order. */
const checkChangeable = <
  T extends {
    type: Source["type"];
    ownerId: string | null;
    archivedAt: Date | null;
  },
>(
  caller: Caller,
  row: T | null
): T => {
  if (!row) throw new NotFoundError("Source not found");
  if (!isUploadSource(row)) throw new NotAnUploadSourceError();
  if (!mayChange(caller, row)) throw lacking(SOURCES_WRITE);
  if (row.archivedAt) throw new SourceArchivedError();
  return row;
};

/**
 * The upload source of `id` if the caller may change it: 404 for none, 409
 * `not_an_upload_source` for a database source, the 403 of a caller without
 * `zeteo.sources.write` for someone else's, 409 `source_archived` once deleted.
 */
export const findChangeable = async (caller: Caller, id: string) => {
  const row = checkChangeable(
    caller,
    await prisma.source.findUnique({ where: { id } })
  );
  assertUploadsOn();
  return row;
};

/**
 * Locks the source's row in `tx` and checks again what `findChangeable`
 * checked: the caller may still change it (a transfer may have landed) and it
 * is not archived.
 */
export const lockChangeable = async (
  tx: Prisma.TransactionClient,
  caller: Caller,
  id: string
) => {
  await tx.$queryRaw`SELECT "id" FROM "zeteo"."sources" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = checkChangeable(
    caller,
    await tx.source.findUnique({ where: { id } })
  );
  return { ...row, ownerId: row.ownerId! };
};

const viewOf = (id: string): Promise<SourceView> => presentSourceById(id);

/** A slug from a name: lowercase letters, digits and hyphens, starting with a letter. */
const slugFrom = (name: string): string => {
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(base)) base = `upload-${base}`.replace(/-+$/, "");
  if (base.length < 2) base = "upload-source";
  return base.slice(0, SLUG_MAX - 9).replace(/-+$/, "");
};

/** The slug from `name`, with `-2`, `-3`... or a random suffix when it is in use. */
const freeSlug = async (name: string): Promise<string> => {
  const base = slugFrom(name);
  for (let n = 1; n <= 20; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await prisma.source.findUnique({ where: { slug } }))) return slug;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
};

/** An owner grant of `tableId` to `ownerId`: their row becomes `all_columns` and flagged, or is created so. */
export const giveOwnerGrant = async (
  tx: Prisma.TransactionClient,
  tableId: string,
  ownerId: string,
  actorId: string
) => {
  const grant = await tx.grant.upsert({
    where: {
      principalType_principalId_tableId: {
        principalType: "user",
        principalId: ownerId,
        tableId,
      },
    },
    create: {
      principalType: "user",
      principalId: ownerId,
      tableId,
      allColumns: true,
      ownerGrant: true,
      createdBy: actorId,
    },
    update: { allColumns: true, ownerGrant: true },
  });
  await tx.grantColumn.deleteMany({ where: { grantId: grant.id } });
};

type Staged = Awaited<ReturnType<typeof getStaging>>;

/** A file table's origin: its file, and the worksheet it was read from when it has one. */
const fileOrigin = (filename: string, key: string): TableOrigin => {
  const sheet = sheetOfKey(key);
  return { kind: "file", filename, ...(sheet !== undefined && { sheet }) };
};

/**
 * The origin of each planned table of a staging, in order: its Google Sheets
 * tab (with the header row it is loaded with) or its file.
 */
const originsOf = (
  staging: Staged,
  keys: string[],
  planned: PlannedTable[]
): TableOrigin[] =>
  planned.map((t, i) => {
    const staged = staging.tables.find((s) => s.key === keys[i])!;
    return staging.kind === "google-sheets"
      ? {
          kind: "google-sheets",
          spreadsheetId: staging.vendorFileId!,
          spreadsheetTitle: staged.spreadsheetTitle ?? "",
          tabTitle: staged.tabTitle ?? "",
          sheetId: staged.locator!.sheetId,
          headerRow: t.headerRow,
        }
      : fileOrigin(staged.filename ?? "", staged.key);
  });

/** The spreadsheet of a Sheets staging; null for a file's. */
const spreadsheetOf = (staging: Staged): string | null =>
  staging.kind === "google-sheets" ? staging.vendorFileId : null;

/** Creates a loaded table's catalogue rows and its owner grant; the load must be swapped in. */
const recordNewTable = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  planned: PlannedTable,
  loaded: Loaded,
  ownerId: string,
  actorId: string,
  now: Date,
  origin: TableOrigin
) => {
  const table = await mapUniqueViolation(
    () =>
      tx.sourceTable.create({
        data: {
          sourceId,
          schemaName: schemaFor(sourceId),
          name: planned.name,
          kind: "table",
          lastSeenAt: now,
          lastSyncedAt: now,
          rowCount: loaded.rowCount,
          origin: { ...origin },
          columns: {
            create: planned.columns.map((c, i) => ({
              name: c.name,
              type: c.type,
              nativeType: NATIVE_TYPE[c.type],
              nullable: true,
              position: i + 1,
              isPrimaryKey: false,
              originalName: c.originalName,
              description: c.originalName || null,
            })),
          },
        },
      }),
    tableNameTaken().message,
    "name_taken"
  );
  await giveOwnerGrant(tx, table.id, ownerId, actorId);
  return table;
};

/** What an audit entry says of a table: never its data. */
const tableMetadata = (
  t: { id: string; name: string; rowCount: bigint | null },
  columns: number
) => ({
  id: t.id,
  name: t.name,
  row_count: t.rowCount === null ? null : Number(t.rowCount),
  columns,
});

const checkDistinctNames = (planned: PlannedTable[]) => {
  const names = new Set<string>();
  for (const t of planned) {
    if (names.has(t.name)) throw tableNameTaken();
    names.add(t.name);
  }
};

export interface CreateUploadSourceInput {
  type: "upload";
  staging_id: string;
  name: string;
  description?: string;
  slug?: string;
  tables: TableCorrection[];
  /**
   * Minutes between syncs of its Sheets tables, kept from a file's staging too
   * (used once it has Sheets tables); 60 for a Sheets staging when not given.
   */
  sync_interval_minutes?: number;
}

/**
 * Makes an upload source of the caller's staging: each table kept is loaded,
 * then the source, its tables, columns and the caller's owner grants are
 * created with the loads swapped in, in one transaction that also checks the
 * caller's quota. On any failure nothing is left: no source row, no schema.
 * A Sheets staging's spreadsheet is claimed in that transaction. The staging
 * is discarded once the source exists.
 */
export const createUploadSource = async (
  caller: Caller,
  input: CreateUploadSourceInput
): Promise<SourceView> => {
  assertUploadsOn();
  const staging = await getStaging(input.staging_id, caller.userId);
  const vendorFileId = spreadsheetOf(staging);
  const sheets = vendorFileId !== null;
  if (vendorFileId) await assertSheetUnclaimed(vendorFileId);
  const planned: PlannedTable[] = [];
  for (const [i, t] of input.tables.entries()) {
    planned.push(await planTable(staging, t, `tables.${i}`));
  }
  checkDistinctNames(planned);
  const origins = originsOf(
    staging,
    input.tables.map((t) => t.key),
    planned
  );
  let slug: string;
  if (input.slug !== undefined) {
    if (await prisma.source.findUnique({ where: { slug: input.slug } })) {
      throw slugTaken();
    }
    slug = input.slug;
  } else {
    slug = await freeSlug(input.name);
  }

  const id = randomUUID();
  await withLoadLock(id, async () => {
    try {
      const loaded = await loadTables(id, planned);
      // New tables only: no merged view reads them yet.
      await inSwap(id, loaded, [], async (tx, audit) => {
        const now = new Date();
        await mapUniqueViolation(
          () =>
            tx.source.create({
              data: {
                id,
                slug,
                name: input.name,
                ...(input.description !== undefined && {
                  description: input.description,
                }),
                type: "upload",
                ownerId: caller.userId,
                sealedSettings: {},
                schemas: [schemaFor(id)],
                createdBy: caller.userId,
                ...(sheets
                  ? {
                      syncIntervalMinutes: input.sync_interval_minutes ?? 60,
                      lastRefreshedAt: now,
                      lastSyncAttemptAt: now,
                    }
                  : input.sync_interval_minutes !== undefined && {
                      syncIntervalMinutes: input.sync_interval_minutes,
                    }),
              },
            }),
          slugTaken().message,
          "name_taken"
        );
        if (vendorFileId) await claimSpreadsheet(tx, id, vendorFileId);
        const tables = [];
        for (const [i, t] of planned.entries()) {
          await swapIn(tx, id, t.name, loaded[i]!.physicalName);
          const table = await recordNewTable(
            tx,
            id,
            t,
            loaded[i]!,
            caller.userId,
            caller.userId,
            now,
            origins[i]!
          );
          tables.push(tableMetadata(table, t.columns.length));
        }
        await checkQuota(tx, caller.userId);
        audit({
          action: AUDIT_EVENTS.sourceCreated,
          resourceType: "source",
          resourceId: id,
          actorId: caller.userId,
          metadata: {
            slug,
            type: input.type,
            name: input.name,
            ...(vendorFileId && { vendor_file_id: vendorFileId }),
            owner_id: caller.userId,
            tables,
            owner_grant: {
              user_id: caller.userId,
              table_ids: tables.map((t) => t.id),
            },
          },
        });
      });
    } catch (err) {
      await dropSourceSchema(id).catch((dropErr: unknown) => {
        logger.error(
          { err: dropErr, source_id: id },
          "dropping the schema of a source not created failed"
        );
      });
      // A racing create of the same spreadsheet may have failed on the slug
      // first: the spreadsheet being claimed is the cause to tell.
      if (vendorFileId && err instanceof ConflictError) {
        await assertSheetUnclaimed(vendorFileId);
      }
      throw err;
    }
  });
  await discardQuietly(staging.id);
  return viewOf(id);
};

const discardQuietly = async (stagingId: string) => {
  await discardStaging(stagingId).catch((err: unknown) => {
    logger.warn({ err, staging_id: stagingId }, "discarding a staging failed");
  });
};

/** What an upload source's owner may change about it. */
export interface UploadSourceDetails {
  name?: string;
  description?: string;
  /** Minutes between syncs, used while it has Google Sheets tables. */
  sync_interval_minutes?: number;
}

/** Renames an upload source or changes its description, for its owner or an admin. */
export const changeUploadSource = async (
  caller: Caller,
  id: string,
  change: UploadSourceDetails
): Promise<SourceView> => {
  await findChangeable(caller, id);
  await withAudit(async (tx, audit) => {
    const row = await lockChangeable(tx, caller, id);
    await tx.source.update({
      where: { id },
      data: {
        ...(change.sync_interval_minutes !== undefined && {
          syncIntervalMinutes: change.sync_interval_minutes,
        }),
        ...(change.name !== undefined && { name: change.name }),
        ...(change.description !== undefined && {
          description: change.description,
        }),
      },
    });
    audit({
      action: AUDIT_EVENTS.sourceUpdated,
      resourceType: "source",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        slug: row.slug,
        type: typeOf(row),
        changed: Object.keys(change),
        ...(change.name !== undefined && { name: change.name }),
      },
    });
  });
  return viewOf(id);
};

/**
 * Runs a change of the source's stored tables that loads nothing (a drop) in
 * an audited transaction with the swap's lock timeout.
 */
export const inDrop = <T>(
  sourceId: string,
  touched: Touched,
  fn: (tx: Prisma.TransactionClient, audit: Audit) => Promise<T>
) => inSwap(sourceId, [], touched, fn);

/**
 * Deletes an upload source: archives it, drops its schema (waiting for queries
 * reading it, up to the swap's lock timeout) and marks its tables and columns
 * missing. Grants and saved queries keep their references; the owner grants
 * lose their `owner_grant` flag, so an admin may remove them. Its claims are
 * released (archiving never fires their foreign key's cascade).
 */
export const deleteUploadSource = async (
  caller: Caller,
  id: string
): Promise<void> => {
  await findChangeable(caller, id);
  await withLoadLock(id, () =>
    inDrop(id, "all", async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      const now = new Date();
      await tx.source.update({ where: { id }, data: { archivedAt: now } });
      await tx.sourceTable.updateMany({
        where: { sourceId: id, missingSince: null },
        data: { missingSince: now },
      });
      await tx.sourceColumn.updateMany({
        where: { table: { sourceId: id }, missingSince: null },
        data: { missingSince: now },
      });
      // Owner grants are locked only while the source lives: once it is
      // deleted they are ordinary grants, which an admin may remove.
      await tx.grant.updateMany({
        where: { table: { sourceId: id }, ownerGrant: true },
        data: { ownerGrant: false },
      });
      await releaseAllClaims(tx, id);
      // Its measures, metrics and their editors go with the source.
      await lockSourceMeasures(tx, id);
      const measures = await tx.measure.deleteMany({ where: { sourceId: id } });
      const metrics = await tx.metric.deleteMany({ where: { sourceId: id } });
      await tx.measureEditor.deleteMany({ where: { sourceId: id } });
      await dropSourceSchema(id, tx);
      audit({
        action: AUDIT_EVENTS.sourceDeleted,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: typeOf(row),
          name: row.name,
          owner_id: row.ownerId,
          measures_removed: measures.count,
          metrics_removed: metrics.count,
        },
      });
    })
  );
  await closeSourcePool(id);
};

/** A Sheets tab's identity: its spreadsheet and sheetId. */
const tabKey = (origin: TableOrigin | null): string | null =>
  origin?.kind === "google-sheets"
    ? `${origin.spreadsheetId}:${origin.sheetId}`
    : null;

/**
 * Marks the previews of a spreadsheet's tabs (`sheet:<sheetId>` keys) that are
 * already live tables of the source with `already_added`; a missing table's tab
 * is not marked.
 */
export const markTabsAlreadyAdded = async <T extends { key: string }>(
  sourceId: string,
  spreadsheetId: string,
  previews: T[]
): Promise<(T & { already_added?: { table_id: string; name: string } })[]> => {
  const tables = await prisma.sourceTable.findMany({
    where: { sourceId, missingSince: null },
    select: { id: true, name: true, origin: true },
  });
  const byTab = new Map<string, { table_id: string; name: string }>();
  for (const t of tables) {
    const key = tabKey(originOf(t));
    if (key !== null) byTab.set(key, { table_id: t.id, name: t.name });
  }
  return previews.map((p) => {
    const existing = byTab.get(
      `${spreadsheetId}:${p.key.replace("sheet:", "")}`
    );
    return existing ? { ...p, already_added: existing } : p;
  });
};

/** 409 `tab_already_added` when a tab of `origins` already backs a table of the source that is not missing. */
const assertTabsFree = async (
  client: Prisma.TransactionClient,
  sourceId: string,
  origins: TableOrigin[]
) => {
  const wanted = origins.map(tabKey).filter((k) => k !== null);
  if (wanted.length === 0) return;
  const tables = await client.sourceTable.findMany({
    where: { sourceId, missingSince: null },
    select: { origin: true },
  });
  const taken = new Set(tables.map((t) => tabKey(originOf(t))));
  if (wanted.some((k) => taken.has(k))) throw new TabAlreadyAddedError();
};

/**
 * Adds the staging's tables (a file's or a spreadsheet's) to the source, each
 * with an owner grant to the source's owner. A spreadsheet is claimed for the
 * source in the same transaction: one another source claims is `sheet_in_use`.
 */
export const addTables = async (
  caller: Caller,
  id: string,
  input: { staging_id: string; tables: TableCorrection[] }
): Promise<SourceView> => {
  await findChangeable(caller, id);
  const staging = await getStaging(input.staging_id, caller.userId);
  const vendorFileId = spreadsheetOf(staging);
  if (vendorFileId) await assertSheetUnclaimed(vendorFileId, id);
  const planned: PlannedTable[] = [];
  for (const [i, t] of input.tables.entries()) {
    planned.push(await planTable(staging, t, `tables.${i}`));
  }
  checkDistinctNames(planned);
  const origins = originsOf(
    staging,
    input.tables.map((t) => t.key),
    planned
  );
  await assertTabsFree(prisma, id, origins);
  const existing = await prisma.sourceTable.findMany({
    where: { sourceId: id, name: { in: planned.map((t) => t.name) } },
  });
  if (existing.length > 0) throw tableNameTaken();

  await withLoadLock(id, async () => {
    const loaded = await loadTables(id, planned);
    // New tables only: no merged view reads them yet.
    await inSwap(id, loaded, [], async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      if (vendorFileId) await claimSpreadsheet(tx, id, vendorFileId);
      await assertTabsFree(tx, id, origins);
      const now = new Date();
      const tables = [];
      for (const [i, t] of planned.entries()) {
        // The name may have been taken since it was checked.
        if (
          await tx.sourceTable.findFirst({
            where: { sourceId: id, name: t.name },
          })
        ) {
          throw tableNameTaken();
        }
        await swapIn(tx, id, t.name, loaded[i]!.physicalName);
        const table = await recordNewTable(
          tx,
          id,
          t,
          loaded[i]!,
          row.ownerId,
          caller.userId,
          now,
          origins[i]!
        );
        tables.push(tableMetadata(table, t.columns.length));
      }
      // The source's first Sheets tables: they sync every 60 minutes until
      // the owner says otherwise.
      if (vendorFileId && row.syncIntervalMinutes === null) {
        await tx.source.update({
          where: { id },
          data: { syncIntervalMinutes: 60 },
        });
      }
      await checkQuota(tx, row.ownerId);
      audit({
        action: AUDIT_EVENTS.sourceTablesAdded,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: typeOf(row),
          changed: ["tables"],
          tables_added: tables,
          owner_grant: {
            user_id: row.ownerId,
            table_ids: tables.map((t) => t.id),
          },
        },
      });
    });
  });
  await discardQuietly(staging.id);
  return viewOf(id);
};

/** A table of the source that is not missing, with its columns; 404 otherwise. */
const findTable = async (sourceId: string, tableId: string) => {
  const table = await prisma.sourceTable.findFirst({
    where: { id: tableId, sourceId, missingSince: null },
    include: { columns: { orderBy: { position: "asc" } } },
  });
  if (!table) throw new NotFoundError("Table not found");
  return table;
};

/** A catalogue column as `matchColumns` reads it. */
type CatalogColumn = Pick<
  SourceColumn,
  "id" | "name" | "originalName" | "type" | "missingSince"
>;

/** The catalogue column each planned column is matched to (undefined: a new one), and the live ones matched by none. */
export interface ColumnMatches<C extends CatalogColumn = CatalogColumn> {
  matched: (C | undefined)[];
  gone: C[];
}

/**
 * Matches a load's planned columns to a table's catalogue columns (live ones
 * first, then missing ones, so a column back again is restored): by `name`, or, for a
 * sync, by the header it was read from (`original_name`), falling back to the
 * name, so a column renamed in Zeteo still matches its sheet header. A
 * matched planned column takes the column's name and, unless the caller set
 * a type, its type (`typeGiven` then holds). A new column whose name a
 * catalogue column already has gets the next free one (`_2`...). Changes
 * `planned` in place.
 */
export const matchColumns = <C extends CatalogColumn>(
  existing: C[],
  planned: PlannedColumn[],
  by: "name" | "original_name"
): ColumnMatches<C> => {
  // Every pass over the live columns runs before any over the missing ones,
  // so a missing column never takes a header a live one still answers to.
  const live = existing.filter((c) => c.missingSince === null);
  const missing = existing.filter((c) => c.missingSince !== null);
  const matched: (C | undefined)[] = planned.map(() => undefined);
  const tests: ((c: C, p: PlannedColumn) => boolean)[] = [
    ...(by === "original_name"
      ? [
          (c: C, p: PlannedColumn) =>
            c.originalName === p.originalName && c.name === p.name,
          (c: C, p: PlannedColumn) =>
            c.originalName !== null && c.originalName === p.originalName,
        ]
      : []),
    (c, p) => c.name === p.name,
  ];
  for (const pool of [live, missing]) {
    for (const test of tests) {
      planned.forEach((p, i) => {
        if (matched[i]) return;
        const at = pool.findIndex((c) => test(c, p));
        if (at !== -1) matched[i] = pool.splice(at, 1)[0];
      });
    }
  }

  const taken = new Set(existing.map((c) => c.name));
  for (const [i, p] of planned.entries()) {
    const match = matched[i];
    if (!match) continue;
    p.name = match.name;
    if (!p.typeGiven && isUploadColumnType(match.type)) {
      p.type = match.type;
      p.typeGiven = true;
    }
  }
  for (const [i, p] of planned.entries()) {
    if (matched[i]) continue;
    if (taken.has(p.name)) p.name = normalizeName(p.name, taken, p.index);
    else taken.add(p.name);
  }
  return { matched, gone: live };
};

/**
 * Writes a loaded table's columns to the catalogue: each matched column
 * updated in place (its id, name and grants kept, restored if missing), each
 * new one created, and the live ones no longer loaded marked missing. Returns
 * how many were added and marked missing.
 */
export const writeColumns = async (
  tx: Prisma.TransactionClient,
  tableId: string,
  planned: PlannedColumn[],
  { matched, gone }: ColumnMatches,
  now: Date
): Promise<{ added: number; missing: number }> => {
  let added = 0;
  for (const [i, c] of planned.entries()) {
    const data = {
      type: c.type,
      nativeType: NATIVE_TYPE[c.type],
      position: i + 1,
      originalName: c.originalName,
      missingSince: null,
    };
    const match = matched[i];
    if (match) {
      await tx.sourceColumn.update({ where: { id: match.id }, data });
    } else {
      await tx.sourceColumn.create({
        data: {
          ...data,
          tableId,
          name: c.name,
          nullable: true,
          isPrimaryKey: false,
          description: c.originalName || null,
        },
      });
      added += 1;
    }
  }
  await tx.sourceColumn.updateMany({
    where: { id: { in: gone.map((c) => c.id) } },
    data: { missingSince: now },
  });
  return { added, missing: gone.length };
};

/**
 * Replaces a table's data from a staging. Columns are matched by name:
 * matched ones keep their id and grants and, unless the caller set a type,
 * their type; new ones are added; those no longer in the file are marked
 * missing (and one back again is no longer missing).
 */
export const reuploadTable = async (
  caller: Caller,
  id: string,
  tableId: string,
  input: { staging_id: string } & Omit<TableCorrection, "name">
): Promise<SourceView> => {
  await findChangeable(caller, id);
  const table = await findTable(id, tableId);
  // Only a file's table is re-uploaded; a Sheets table follows its tab.
  if (!isFileTable(table)) throw new NotAFileUploadError();
  const staging = await getStaging(input.staging_id, caller.userId);
  if (staging.kind === "google-sheets") {
    throw new NotAFileUploadError(
      "A file's table is re-uploaded from a file, not a Google Sheet."
    );
  }
  const filename = staging.tables.find((t) => t.key === input.key)?.filename;
  const planned = await planTable(
    staging,
    { key: input.key, header_row: input.header_row, columns: input.columns },
    "",
    table.name
  );

  await withLoadLock(id, async () => {
    // Under the lock no other change of the table's columns runs: these are
    // its columns until the swap.
    const columns = await prisma.sourceColumn.findMany({
      where: { tableId },
      orderBy: { position: "asc" },
    });
    const matches = matchColumns(columns, planned.columns, "name");
    const [loaded] = await loadTables(id, [planned]);
    await inSwap(id, [loaded!], [tableId], async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      const now = new Date();
      // Read again under the lock: a rename may have landed since.
      const fresh = await tx.sourceTable.findFirst({
        where: { id: tableId, sourceId: id, missingSince: null },
      });
      if (!fresh || fresh.name !== planned.name) {
        throw new NotFoundError("Table not found");
      }
      await swapIn(tx, id, planned.name, loaded!.physicalName);
      const { added, missing } = await writeColumns(
        tx,
        tableId,
        planned.columns,
        matches,
        now
      );
      await tx.sourceTable.update({
        where: { id: tableId },
        data: {
          rowCount: loaded!.rowCount,
          lastSyncedAt: now,
          lastSeenAt: now,
          ...(filename !== undefined && {
            origin: fileOrigin(filename, input.key),
          }),
        },
      });
      await checkQuota(tx, row.ownerId);
      audit({
        action: AUDIT_EVENTS.sourceTableReuploaded,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: "upload",
          table: {
            id: tableId,
            name: planned.name,
            row_count: loaded!.rowCount,
          },
          columns_added: added,
          columns_missing: missing,
        },
      });
    });
  });
  await discardQuietly(staging.id);
  return viewOf(id);
};

/**
 * Whether a table may be removed: one that is not missing, or a Sheets table
 * a sync marked missing (its tab deleted in Sheets), which removing stops a
 * sync bringing back and frees its spreadsheet's claim.
 */
const removable = (table: { missingSince: Date | null; origin: unknown }) => {
  if (table.missingSince === null) return true;
  const origin = originOf(table);
  return origin?.kind === "google-sheets" && origin.removed !== true;
};

/**
 * Drops a table and marks it and its columns missing; grants keep their
 * references. A Sheets table's origin is marked `removed`, so a sync leaves
 * it missing (its tab can be added again as a new table), and the source's
 * claim of its spreadsheet is released when no other table uses it; a Sheets
 * table a sync marked missing can be removed so too. A merged table's view
 * is dropped. A table a live merged table reads is 409
 * `table_in_merged_table`. Its measures, and the metrics using them, go with
 * it; one of another table using its measures is 409 `measure_in_use`.
 */
export const removeTable = async (
  caller: Caller,
  id: string,
  tableId: string
): Promise<void> => {
  await findChangeable(caller, id);
  const found = await prisma.sourceTable.findFirst({
    where: { id: tableId, sourceId: id },
  });
  if (!found || !removable(found)) throw new NotFoundError("Table not found");
  await assertNotMerged(prisma, id, tableId);
  await withLoadLock(id, () =>
    inDrop(id, [tableId], async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      const table = await tx.sourceTable.findFirst({
        where: { id: tableId, sourceId: id },
      });
      if (!table || !removable(table)) {
        throw new NotFoundError("Table not found");
      }
      await assertNotMerged(tx, id, tableId);
      // A measure lives on its home table: it goes with it, as does a metric
      // using one. A measure of another table using one (a fixed measure is
      // usable from any table) would be left broken: as for a measure's
      // delete, that refuses the removal before anything changes.
      await lockSourceMeasures(tx, id);
      const removal = tableRemoval(
        tableId,
        (await tx.measure.findMany({ where: { sourceId: id } })).map(
          toMeasureRow
        ),
        (await tx.metric.findMany({ where: { sourceId: id } })).map(toMetricRow)
      );
      if (removal.blocking.length > 0) {
        throw new MeasureInUseError(removal.blocking, "this table's measures");
      }
      const now = new Date();
      const origin = originOf(table);
      // A merged table's view is already dropped (`inDrop`) and is not
      // created again once it is missing; a missing table has nothing stored.
      if (table.missingSince === null && origin?.kind !== "merged") {
        await dropStoredTable(tx, id, table.name);
      }
      // A Sheets table's origin is marked removed so a sync never brings
      // it back as it does a table whose tab was deleted in Sheets.
      await tx.sourceTable.update({
        where: { id: tableId },
        data: {
          missingSince: table.missingSince ?? now,
          ...(origin?.kind === "google-sheets" && {
            origin: { ...origin, removed: true },
          }),
        },
      });
      await tx.sourceColumn.updateMany({
        where: { tableId, missingSince: null },
        data: { missingSince: now },
      });
      if (origin?.kind === "google-sheets") {
        await releaseUnusedClaims(tx, id);
      }
      const measuresRemoved = removal.measures.map((m) => ({
        id: m.id,
        name: m.name,
      }));
      const metricsRemoved = removal.metrics.map((m) => ({
        id: m.id,
        name: m.name,
      }));
      if (measuresRemoved.length > 0) {
        await tx.measure.deleteMany({
          where: { id: { in: measuresRemoved.map((m) => m.id) } },
        });
      }
      if (metricsRemoved.length > 0) {
        await tx.metric.deleteMany({
          where: { id: { in: metricsRemoved.map((m) => m.id) } },
        });
      }
      // Each one gone is recorded as its own delete would be, saying why.
      const withTable = {
        source_id: id,
        slug: row.slug,
        removed_with_table: { id: tableId, name: table.name },
      };
      for (const m of measuresRemoved) {
        audit({
          action: AUDIT_EVENTS.measureDeleted,
          resourceType: "measure",
          resourceId: m.id,
          actorId: caller.userId,
          metadata: { ...withTable, name: m.name },
        });
      }
      for (const m of metricsRemoved) {
        audit({
          action: AUDIT_EVENTS.metricDeleted,
          resourceType: "metric",
          resourceId: m.id,
          actorId: caller.userId,
          metadata: { ...withTable, name: m.name },
        });
      }
      audit({
        action: AUDIT_EVENTS.sourceTableRemoved,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: typeOf(row),
          changed: ["tables"],
          tables_removed: [{ id: tableId, name: table.name }],
          measures_removed: measuresRemoved,
          metrics_removed: metricsRemoved,
        },
      });
    })
  );
};

/** 409 `table_in_merged_table` when a live merged table of the source lists the table as a member. */
const assertNotMerged = async (
  client: Prisma.TransactionClient,
  sourceId: string,
  tableId: string
) => {
  const tables = await client.sourceTable.findMany({
    where: {
      sourceId,
      missingSince: null,
      origin: { path: ["kind"], equals: "merged" },
    },
    select: { name: true, origin: true },
    orderBy: { name: "asc" },
  });
  for (const t of tables) {
    const origin = originOf(t);
    if (
      origin?.kind === "merged" &&
      origin.definition.members.some((m) => m.tableId === tableId)
    ) {
      throw new TableInMergedTableError(t.name);
    }
  }
};

export interface ColumnChange {
  type?: UploadColumnType;
  name?: string;
  description?: string | null;
}

/**
 * Changes a column. A new type or name reloads the table from its stored
 * values as text, under the load lock; the column keeps its id and grants,
 * and a value that does not cast fails with `cast_failed`, changing nothing.
 * A description alone changes only the catalogue.
 */
export const changeColumn = async (
  caller: Caller,
  id: string,
  tableId: string,
  columnId: string,
  change: ColumnChange
): Promise<SourceView> => {
  await findChangeable(caller, id);
  const table = await findTable(id, tableId);
  const column = table.columns.find(
    (c) => c.id === columnId && c.missingSince === null
  );
  if (!column) throw new NotFoundError("Column not found");
  const rename = change.name !== undefined && change.name !== column.name;
  if (rename && table.columns.some((c) => c.name === change.name)) {
    throw columnNameTaken();
  }
  const retype = change.type !== undefined && change.type !== column.type;
  const merged = isMergedTable(table);
  if (merged && retype) {
    throw new ValidationError(
      "Invalid request body. type: A merged table's column takes its type from its members; edit the merged table",
      [
        {
          path: "type",
          message:
            "A merged table's column takes its type from its members; edit the merged table",
        },
      ]
    );
  }

  const record = async (tx: Prisma.TransactionClient, audit: Audit) => {
    const row = await lockChangeable(tx, caller, id);
    const fresh = await tx.sourceColumn.findFirst({
      where: { id: columnId, tableId, missingSince: null },
    });
    if (!fresh) throw new NotFoundError("Column not found");
    const changed = [
      ...(retype ? ["type"] : []),
      ...(rename ? ["name"] : []),
      ...(change.description !== undefined ? ["description"] : []),
    ];
    await mapUniqueViolation(
      () =>
        tx.sourceColumn.update({
          where: { id: columnId },
          data: {
            ...(retype && {
              type: change.type,
              nativeType: NATIVE_TYPE[change.type!],
            }),
            ...(rename && { name: change.name }),
            ...(change.description !== undefined && {
              description: change.description,
            }),
          },
        }),
      columnNameTaken().message,
      "name_taken"
    );
    audit({
      action: AUDIT_EVENTS.sourceUpdated,
      resourceType: "source",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        slug: row.slug,
        type: typeOf(row),
        changed: ["columns"],
        column: {
          id: columnId,
          table_id: tableId,
          changed,
          ...(retype && { type: { from: fresh.type, to: change.type } }),
          ...(rename && { name: { from: fresh.name, to: change.name } }),
        },
      },
    });
    return row;
  };

  if (!retype && !rename) {
    await withAudit(record);
    return viewOf(id);
  }

  // A merged table's column is renamed in the catalogue; its view is made
  // again from it.
  if (merged) {
    await withLoadLock(id, () => inDrop(id, [tableId], record));
    return viewOf(id);
  }

  await withLoadLock(id, async () => {
    // Under the lock, no other load of the source runs: these are its columns.
    const columns = await prisma.sourceColumn.findMany({
      where: { tableId, missingSince: null },
      orderBy: { position: "asc" },
    });
    const target = columns.find((c) => c.id === columnId);
    if (!target) throw new NotFoundError("Column not found");
    const staging = await stageStoredTable(
      id,
      table.name,
      columns.map((c) => c.name)
    );
    try {
      const planned: PlannedTable = {
        name: table.name,
        stagingTable: staging,
        headerRow: null,
        columns: columns.map((c, index) => {
          const own = c.id === columnId;
          const type = own && change.type ? change.type : c.type;
          if (!isUploadColumnType(type)) {
            throw new Error(`A file column of type ${type}`);
          }
          return {
            index,
            name: own && change.name ? change.name : c.name,
            originalName: c.originalName ?? c.name,
            type,
            typeGiven: true,
          };
        }),
      };
      const [loaded] = await loadTables(id, [planned]);
      await inSwap(id, [loaded!], [tableId], async (tx, audit) => {
        const row = await record(tx, audit);
        await swapIn(tx, id, table.name, loaded!.physicalName);
        const now = new Date();
        await tx.sourceTable.update({
          where: { id: tableId },
          data: { rowCount: loaded!.rowCount, lastSyncedAt: now },
        });
        await checkQuota(tx, row.ownerId);
      });
    } finally {
      await dropStagingTable(staging).catch((err: unknown) => {
        logger.warn({ err, table: staging }, "dropping a staging table failed");
      });
    }
  });
  return viewOf(id);
};

/**
 * Hands the source to another user (not a service account): the owner grants
 * move to them (a grant they had becomes the owner grant), and the previous
 * owner keeps an ordinary `all_columns` grant unless `keepAccess` is false.
 */
export const transferUploadSource = async (
  caller: Caller,
  id: string,
  { userId, keepAccess }: { userId: string; keepAccess: boolean }
): Promise<SourceView> => {
  const found = await findChangeable(caller, id);
  if (found.ownerId === userId) throw alreadyOwnerError(NOUN);
  // Tereo is asked here, before the transaction.
  await checkTransferTarget(userId, NOUN);
  try {
    await withAudit(async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      if (row.ownerId === userId) throw alreadyOwnerError(NOUN);
      const tables = await tx.sourceTable.findMany({
        where: { sourceId: id },
        select: { id: true },
      });
      const tableIds = tables.map((t) => t.id);
      await tx.grant.updateMany({
        where: { tableId: { in: tableIds }, ownerGrant: true },
        data: { ownerGrant: false },
      });
      const removed = keepAccess
        ? []
        : await tx.grant.findMany({
            where: {
              tableId: { in: tableIds },
              principalType: "user",
              principalId: row.ownerId,
            },
            select: { id: true },
          });
      await tx.grant.deleteMany({
        where: { id: { in: removed.map((g) => g.id) } },
      });
      for (const tableId of tableIds) {
        await giveOwnerGrant(tx, tableId, userId, caller.userId);
      }
      await tx.source.update({ where: { id }, data: { ownerId: userId } });
      // The source now counts against the new owner's quota.
      await checkQuota(tx, userId);
      audit({
        action: AUDIT_EVENTS.sourceTransferred,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: typeOf(row),
          from: row.ownerId,
          to: userId,
          keep_access: keepAccess,
          owner_grant: { user_id: userId, table_ids: tableIds },
          grants_removed: removed.map((g) => g.id),
        },
      });
    });
  } catch (err) {
    if (isDatabaseBusy(err)) throw new UploadSourceBusyError();
    throw err;
  }
  return viewOf(id);
};
