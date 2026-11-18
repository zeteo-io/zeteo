import { alreadyOwnerError, checkTransferTarget } from "../sharing/shares.js";
import { withAudit, type Audit } from "../utils/transaction.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import { presentSourceById } from "../sources/present.js";
import { discardStaging, getStaging } from "./staging.js";
import { hasPermission } from "../utils/permissions.js";
import { closeSourcePool } from "../sources/pools.js";
import type { SourceView } from "../views/source.js";
import type { Caller } from "../middleware/auth.js";
import type { UploadColumnType } from "./types.js";
import { logger } from "../utils/logger.js";
import { lacking } from "./ownership.js";
import { randomUUID } from "crypto";
import env from "../env.js";
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
  NotAnUploadSourceError,
  NotFoundError,
  SourceArchivedError,
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
const tableNameTaken = () =>
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
  T extends { type: string; ownerId: string | null; archivedAt: Date | null },
>(
  caller: Caller,
  row: T | null
): T => {
  if (!row) throw new NotFoundError("Source not found");
  if (row.type !== "upload") throw new NotAnUploadSourceError();
  if (!mayChange(caller, row)) throw lacking(SOURCES_WRITE);
  if (row.archivedAt) throw new SourceArchivedError();
  return row;
};

/**
 * The upload source of `id` if the caller may change it: 404 for none, 409
 * `not_an_upload_source` for a database source, the 403 of a caller without
 * `zeteo.sources.write` for someone else's, 409 `source_archived` once deleted.
 */
const findChangeable = async (caller: Caller, id: string) => {
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
const lockChangeable = async (
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
const giveOwnerGrant = async (
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

/** Creates a loaded table's catalogue rows and its owner grant; the load must be swapped in. */
const recordNewTable = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  planned: PlannedTable,
  loaded: Loaded,
  ownerId: string,
  actorId: string,
  now: Date
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
  staging_id: string;
  name: string;
  slug?: string;
  tables: TableCorrection[];
}

/**
 * Makes an upload source of the caller's staging: each table kept is loaded,
 * then the source, its tables, columns and the caller's owner grants are
 * created with the loads swapped in, in one transaction that also checks the
 * caller's quota. On any failure nothing is left: no source row, no schema.
 * The staging is discarded once the source exists.
 */
export const createUploadSource = async (
  caller: Caller,
  input: CreateUploadSourceInput
): Promise<SourceView> => {
  assertUploadsOn();
  const staging = await getStaging(input.staging_id, caller.userId);
  const planned: PlannedTable[] = [];
  for (const [i, t] of input.tables.entries()) {
    planned.push(await planTable(staging, t, `tables.${i}`));
  }
  checkDistinctNames(planned);
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
      await inSwap(id, loaded, async (tx, audit) => {
        const now = new Date();
        await mapUniqueViolation(
          () =>
            tx.source.create({
              data: {
                id,
                slug,
                name: input.name,
                type: "upload",
                ownerId: caller.userId,
                sealedSettings: {},
                schemas: [schemaFor(id)],
                createdBy: caller.userId,
              },
            }),
          slugTaken().message,
          "name_taken"
        );
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
            now
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
            type: "upload",
            name: input.name,
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

export const renameUploadSource = async (
  caller: Caller,
  id: string,
  name: string
): Promise<SourceView> => {
  await findChangeable(caller, id);
  await withAudit(async (tx, audit) => {
    const row = await lockChangeable(tx, caller, id);
    await tx.source.update({ where: { id }, data: { name } });
    audit({
      action: AUDIT_EVENTS.sourceUpdated,
      resourceType: "source",
      resourceId: id,
      actorId: caller.userId,
      metadata: { slug: row.slug, type: "upload", changed: ["name"], name },
    });
  });
  return viewOf(id);
};

/**
 * Runs a change of the source's stored tables that loads nothing (a drop) in
 * an audited transaction with the swap's lock timeout.
 */
const inDrop = <T>(
  sourceId: string,
  fn: (tx: Prisma.TransactionClient, audit: Audit) => Promise<T>
) => inSwap(sourceId, [], fn);

/**
 * Deletes an upload source: archives it, drops its schema (waiting for queries
 * reading it, up to the swap's lock timeout) and marks its tables and columns
 * missing. Grants and saved queries keep their references; the owner grants
 * lose their `owner_grant` flag, so an admin may remove them.
 */
export const deleteUploadSource = async (
  caller: Caller,
  id: string
): Promise<void> => {
  await findChangeable(caller, id);
  await withLoadLock(id, () =>
    inDrop(id, async (tx, audit) => {
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
      await dropSourceSchema(id, tx);
      audit({
        action: AUDIT_EVENTS.sourceDeleted,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: "upload",
          name: row.name,
          owner_id: row.ownerId,
        },
      });
    })
  );
  await closeSourcePool(id);
};

/** Adds the staging's tables to the source, each with an owner grant to the source's owner. */
export const addTables = async (
  caller: Caller,
  id: string,
  input: { staging_id: string; tables: TableCorrection[] }
): Promise<SourceView> => {
  await findChangeable(caller, id);
  const staging = await getStaging(input.staging_id, caller.userId);
  const planned: PlannedTable[] = [];
  for (const [i, t] of input.tables.entries()) {
    planned.push(await planTable(staging, t, `tables.${i}`));
  }
  checkDistinctNames(planned);
  const existing = await prisma.sourceTable.findMany({
    where: { sourceId: id, name: { in: planned.map((t) => t.name) } },
  });
  if (existing.length > 0) throw tableNameTaken();

  await withLoadLock(id, async () => {
    const loaded = await loadTables(id, planned);
    await inSwap(id, loaded, async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
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
          now
        );
        tables.push(tableMetadata(table, t.columns.length));
      }
      await checkQuota(tx, row.ownerId);
      audit({
        action: AUDIT_EVENTS.sourceTablesAdded,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: "upload",
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
  const staging = await getStaging(input.staging_id, caller.userId);
  const planned = await planTable(
    staging,
    { key: input.key, header_row: input.header_row, columns: input.columns },
    "",
    table.name
  );
  const current = new Map(table.columns.map((c) => [c.name, c]));
  for (const c of planned.columns) {
    const match = current.get(c.name);
    if (!c.typeGiven && match && isUploadColumnType(match.type))
      c.type = match.type;
  }

  await withLoadLock(id, async () => {
    const [loaded] = await loadTables(id, [planned]);
    await inSwap(id, [loaded!], async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      const now = new Date();
      // Read again under the lock: a rename may have landed since.
      const fresh = await tx.sourceTable.findFirst({
        where: { id: tableId, sourceId: id, missingSince: null },
        include: { columns: true },
      });
      if (!fresh || fresh.name !== planned.name) {
        throw new NotFoundError("Table not found");
      }
      await swapIn(tx, id, planned.name, loaded!.physicalName);
      const byName = new Map(fresh.columns.map((c) => [c.name, c]));
      let added = 0;
      for (const [i, c] of planned.columns.entries()) {
        const data = {
          type: c.type,
          nativeType: NATIVE_TYPE[c.type],
          position: i + 1,
          originalName: c.originalName,
          missingSince: null,
        };
        const match = byName.get(c.name);
        if (match) {
          await tx.sourceColumn.update({ where: { id: match.id }, data });
          byName.delete(c.name);
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
      const gone = [...byName.values()].filter((c) => c.missingSince === null);
      await tx.sourceColumn.updateMany({
        where: { id: { in: gone.map((c) => c.id) } },
        data: { missingSince: now },
      });
      await tx.sourceTable.update({
        where: { id: tableId },
        data: {
          rowCount: loaded!.rowCount,
          lastSyncedAt: now,
          lastSeenAt: now,
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
          columns_missing: gone.length,
        },
      });
    });
  });
  await discardQuietly(staging.id);
  return viewOf(id);
};

/** Drops a table and marks it and its columns missing; grants keep their references. */
export const removeTable = async (
  caller: Caller,
  id: string,
  tableId: string
): Promise<void> => {
  await findChangeable(caller, id);
  await findTable(id, tableId);
  await withLoadLock(id, () =>
    inDrop(id, async (tx, audit) => {
      const row = await lockChangeable(tx, caller, id);
      const table = await tx.sourceTable.findFirst({
        where: { id: tableId, sourceId: id, missingSince: null },
      });
      if (!table) throw new NotFoundError("Table not found");
      const now = new Date();
      await dropStoredTable(tx, id, table.name);
      await tx.sourceTable.update({
        where: { id: tableId },
        data: { missingSince: now },
      });
      await tx.sourceColumn.updateMany({
        where: { tableId, missingSince: null },
        data: { missingSince: now },
      });
      audit({
        action: AUDIT_EVENTS.sourceTableRemoved,
        resourceType: "source",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          slug: row.slug,
          type: "upload",
          changed: ["tables"],
          tables_removed: [{ id: tableId, name: table.name }],
        },
      });
    })
  );
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
        type: "upload",
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
      await inSwap(id, [loaded!], async (tx, audit) => {
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
          type: "upload",
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
