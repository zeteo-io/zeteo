import type { SchemaSnapshot, SnapshotColumn } from "../adapters/types.js";
import { forwardName, reverseName, uniqueName } from "./relationNames.js";
import type { Source } from "../../prisma/generated/client/index.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { withSourceConnection } from "../sources/pools.js";
import type { Prisma } from "../utils/db/prisma.js";
import { withAudit } from "../utils/transaction.js";
import { db, prisma } from "../utils/db/index.js";
import { lockSourceCatalog } from "./lock.js";
import { typeOf } from "../sources/types.js";
import { logger } from "../utils/logger.js";
import {
  HostNotAllowedError,
  NotFoundError,
  SourceArchivedError,
  SourceUnreachableError,
} from "../utils/errors.js";

export interface RefreshSummary {
  tables: { added: number; missing: number; restored: number };
  columns: {
    added: number;
    changed: number;
    missing: number;
    restored: number;
  };
  relations: { added: number; missing: number; restored: number };
}

/**
 * Rounds of "read, then find another refresh landed first" before a refresh
 * applies the snapshot it has. Each round lost means another refresh finished.
 */
const MAX_READ_ROUNDS = 5;

/**
 * How long the transaction that applies a snapshot may run: a source with
 * thousands of tables writes far more rows than an ordinary change.
 */
export const REFRESH_TRANSACTION_TIMEOUT_MS = 120_000;

/** Rows per statement; Postgres allows 32767 bind parameters in one. */
const CHUNK = 2000;

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
};

const tableKey = (schemaName: string, name: string) =>
  `${schemaName}\u0000${name}`;

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const emptySummary = (): RefreshSummary => ({
  tables: { added: 0, missing: 0, restored: 0 },
  columns: { added: 0, changed: 0, missing: 0, restored: 0 },
  relations: { added: 0, missing: 0, restored: 0 },
});

/** The key a discovered relation is matched on across refreshes: its constraint, the table that holds the foreign key, and the direction. */
const relationKey = (
  constraintName: string,
  keyTableId: string,
  toMany: boolean
) => `${constraintName}\u0000${keyTableId}\u0000${toMany}`;

const readSnapshot = async (row: Source): Promise<SchemaSnapshot> => {
  try {
    return await withSourceConnection(row.id, (conn) =>
      conn.readSchema(row.schemas)
    );
  } catch (err) {
    if (
      err instanceof SourceUnreachableError ||
      err instanceof HostNotAllowedError
    ) {
      // Only the status changes; the catalogue keeps what it knew. Only while
      // no refresh has landed and the settings have not changed since the read
      // began: a newer success, or a failure of settings since replaced, stands.
      await prisma.source
        .updateMany({
          where: {
            id: row.id,
            lastRefreshedAt: row.lastRefreshedAt,
            updatedAt: row.updatedAt,
          },
          data: { status: "unreachable" },
        })
        .catch((cause: unknown) => {
          logger.error(
            { err: cause, source_id: row.id },
            "marking the source unreachable failed"
          );
        });
    }
    throw err;
  }
};

const columnChanged = (
  existing: {
    type: string;
    nativeType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    position: number;
  },
  next: SnapshotColumn
) =>
  existing.type !== next.type ||
  existing.nativeType !== next.nativeType ||
  existing.nullable !== next.nullable ||
  existing.isPrimaryKey !== next.isPrimaryKey;

/**
 * Writes the snapshot into the catalogue in the caller's transaction and
 * returns what changed. Nothing is deleted, and no id or description changes.
 */
const applySnapshot = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  snapshot: SchemaSnapshot
): Promise<RefreshSummary> => {
  const now = new Date();
  const summary = emptySummary();

  // --- tables ---
  const existingTables = await tx.sourceTable.findMany({ where: { sourceId } });
  const tableByKey = new Map(
    existingTables.map((t) => [tableKey(t.schemaName, t.name), t])
  );
  const seenKeys = new Set<string>();
  const newTables: Prisma.SourceTableCreateManyInput[] = [];
  const seenIds: string[] = [];
  for (const table of snapshot.tables) {
    const key = tableKey(table.schemaName, table.name);
    seenKeys.add(key);
    const found = tableByKey.get(key);
    if (!found) {
      newTables.push({
        sourceId,
        schemaName: table.schemaName,
        name: table.name,
        kind: table.kind,
        lastSeenAt: now,
      });
      summary.tables.added++;
      continue;
    }
    seenIds.push(found.id);
    if (found.missingSince) summary.tables.restored++;
    if (found.kind !== table.kind) {
      await tx.sourceTable.update({
        where: { id: found.id },
        data: { kind: table.kind },
      });
    }
  }
  const newlyMissingTableIds = existingTables
    .filter(
      (t) =>
        !seenKeys.has(tableKey(t.schemaName, t.name)) && t.missingSince === null
    )
    .map((t) => t.id);
  summary.tables.missing = newlyMissingTableIds.length;
  for (const rows of chunks(newTables)) {
    await tx.sourceTable.createMany({ data: rows });
  }
  for (const ids of chunks(seenIds)) {
    await tx.sourceTable.updateMany({
      where: { id: { in: ids } },
      data: { lastSeenAt: now, missingSince: null },
    });
  }
  for (const ids of chunks(newlyMissingTableIds)) {
    await tx.sourceTable.updateMany({
      where: { id: { in: ids } },
      data: { missingSince: now },
    });
  }

  const tables = await tx.sourceTable.findMany({ where: { sourceId } });
  const tableIdByKey = new Map(
    tables.map((t) => [tableKey(t.schemaName, t.name), t.id])
  );

  // --- columns ---
  const existingColumns = await tx.sourceColumn.findMany({
    where: { table: { sourceId } },
  });
  const columnsByTable = new Map<
    string,
    Map<string, (typeof existingColumns)[number]>
  >();
  for (const column of existingColumns) {
    let byName = columnsByTable.get(column.tableId);
    if (!byName) columnsByTable.set(column.tableId, (byName = new Map()));
    byName.set(column.name, column);
  }
  const seenColumnIds = new Set<string>();
  const newColumns: Prisma.SourceColumnCreateManyInput[] = [];
  const updates: Array<{ id: string; column: SnapshotColumn }> = [];
  for (const table of snapshot.tables) {
    const tableId = tableIdByKey.get(tableKey(table.schemaName, table.name))!;
    const byName = columnsByTable.get(tableId);
    for (const column of table.columns) {
      const found = byName?.get(column.name);
      if (!found) {
        newColumns.push({
          tableId,
          name: column.name,
          type: column.type,
          nativeType: column.nativeType,
          nullable: column.nullable,
          position: column.position,
          isPrimaryKey: column.isPrimaryKey,
        });
        summary.columns.added++;
        continue;
      }
      seenColumnIds.add(found.id);
      if (found.missingSince) summary.columns.restored++;
      const attributesChanged = columnChanged(found, column);
      if (attributesChanged) summary.columns.changed++;
      if (
        attributesChanged ||
        found.position !== column.position ||
        found.missingSince
      ) {
        updates.push({ id: found.id, column });
      }
    }
  }
  const newlyMissingColumnIds = existingColumns
    .filter((c) => !seenColumnIds.has(c.id) && c.missingSince === null)
    .map((c) => c.id);
  summary.columns.missing = newlyMissingColumnIds.length;
  for (const rows of chunks(newColumns)) {
    await tx.sourceColumn.createMany({ data: rows });
  }
  for (const rows of chunks(updates)) {
    await tx.$executeRaw`
      UPDATE "zeteo"."source_columns" AS c
         SET "type" = v."type"::"zeteo"."column_type",
             "native_type" = v."native_type",
             "nullable" = v."nullable",
             "position" = v."position",
             "is_primary_key" = v."is_primary_key",
             "missing_since" = NULL
        FROM unnest(
               ${rows.map((r) => r.id)}::uuid[],
               ${rows.map((r) => r.column.type)}::text[],
               ${rows.map((r) => r.column.nativeType)}::text[],
               ${rows.map((r) => r.column.nullable)}::boolean[],
               ${rows.map((r) => r.column.position)}::int[],
               ${rows.map((r) => r.column.isPrimaryKey)}::boolean[]
             ) AS v("id", "type", "native_type", "nullable", "position", "is_primary_key")
       WHERE c."id" = v."id"`;
  }
  for (const ids of chunks(newlyMissingColumnIds)) {
    await tx.sourceColumn.updateMany({
      where: { id: { in: ids } },
      data: { missingSince: now },
    });
  }

  // --- discovered relations ---
  const existingRelations = await tx.relation.findMany({ where: { sourceId } });
  const taken = new Map<string, Set<string>>();
  const takenOn = (tableId: string) => {
    let names = taken.get(tableId);
    if (!names) taken.set(tableId, (names = new Set()));
    return names;
  };
  for (const r of existingRelations) takenOn(r.fromTableId).add(r.name);

  // Only foreign keys whose tables and columns are all in this snapshot: a
  // table or column marked missing above must not keep a live relation.
  const columnsInSnapshot = new Map(
    snapshot.tables.map((t) => [
      tableKey(t.schemaName, t.name),
      new Set(t.columns.map((c) => c.name)),
    ])
  );
  const present = (end: {
    schemaName: string;
    table: string;
    columns: string[];
  }) => {
    const names = columnsInSnapshot.get(tableKey(end.schemaName, end.table));
    return names !== undefined && end.columns.every((c) => names.has(c));
  };

  interface Side {
    constraintName: string;
    keyTableId: string;
    toMany: boolean;
    tableId: string;
    columns: string[];
    otherId: string;
    otherColumns: string[];
    baseName: string;
  }
  const sides: Side[] = [];
  for (const fk of snapshot.foreignKeys) {
    if (!present(fk.from) || !present(fk.to)) continue;
    const fromId = tableIdByKey.get(
      tableKey(fk.from.schemaName, fk.from.table)
    );
    const toId = tableIdByKey.get(tableKey(fk.to.schemaName, fk.to.table));
    if (!fromId || !toId) continue;
    sides.push(
      {
        constraintName: fk.constraintName,
        keyTableId: fromId,
        toMany: false,
        tableId: fromId,
        columns: fk.from.columns,
        otherId: toId,
        otherColumns: fk.to.columns,
        baseName: forwardName(fk),
      },
      {
        constraintName: fk.constraintName,
        keyTableId: fromId,
        toMany: true,
        tableId: toId,
        columns: fk.to.columns,
        otherId: fromId,
        otherColumns: fk.from.columns,
        baseName: reverseName(fk),
      }
    );
  }

  const existingDiscovered = existingRelations
    .filter((r) => r.origin === "discovered" && r.constraintName !== null)
    .sort((a, b) =>
      a.constraintName! === b.constraintName!
        ? a.id.localeCompare(b.id)
        : a.constraintName! < b.constraintName!
          ? -1
          : 1
    );
  const claimed = new Set<string>();
  const matched = new Map<Side, (typeof existingRelations)[number]>();
  const byKey = new Map<string, typeof existingDiscovered>();
  const byShape = new Map<string, typeof existingDiscovered>();
  const index = (
    map: Map<string, typeof existingDiscovered>,
    key: string,
    row: (typeof existingDiscovered)[number]
  ) => {
    const rows = map.get(key);
    if (rows) rows.push(row);
    else map.set(key, [row]);
  };
  const shapeKey = (
    toMany: boolean,
    fromId: string,
    fromColumns: string[],
    toId: string,
    toColumns: string[]
  ) => JSON.stringify([toMany, fromId, fromColumns, toId, toColumns]);
  for (const r of existingDiscovered) {
    index(
      byKey,
      relationKey(
        r.constraintName!,
        r.toMany ? r.toTableId : r.fromTableId,
        r.toMany
      ),
      r
    );
    index(
      byShape,
      shapeKey(
        r.toMany,
        r.fromTableId,
        r.fromColumns,
        r.toTableId,
        r.toColumns
      ),
      r
    );
  }
  const claim = (rows: typeof existingDiscovered | undefined, side: Side) => {
    const found = rows?.find((r) => !claimed.has(r.id));
    if (!found) return false;
    claimed.add(found.id);
    matched.set(side, found);
    return true;
  };
  // Exact constraint name first, then the same shape under another name
  // (a renamed or re-created constraint); a row is taken over at most once.
  for (const side of sides) {
    claim(
      byKey.get(relationKey(side.constraintName, side.keyTableId, side.toMany)),
      side
    );
  }
  for (const side of sides) {
    if (matched.has(side)) continue;
    claim(
      byShape.get(
        shapeKey(
          side.toMany,
          side.tableId,
          side.columns,
          side.otherId,
          side.otherColumns
        )
      ),
      side
    );
  }

  const newRelations: Prisma.RelationCreateManyInput[] = [];
  for (const side of sides) {
    const found = matched.get(side);
    if (!found) {
      const name = uniqueName(side.baseName, takenOn(side.tableId));
      takenOn(side.tableId).add(name);
      newRelations.push({
        sourceId,
        name,
        fromTableId: side.tableId,
        fromColumns: side.columns,
        toTableId: side.otherId,
        toColumns: side.otherColumns,
        toMany: side.toMany,
        origin: "discovered",
        constraintName: side.constraintName,
      });
      summary.relations.added++;
      continue;
    }
    if (found.missingSince) summary.relations.restored++;
    const moved = found.fromTableId !== side.tableId;
    if (
      found.missingSince ||
      moved ||
      found.constraintName !== side.constraintName ||
      found.toTableId !== side.otherId ||
      !same(found.fromColumns, side.columns) ||
      !same(found.toColumns, side.otherColumns)
    ) {
      let name = found.name;
      if (moved) {
        name = uniqueName(found.name, takenOn(side.tableId));
        takenOn(side.tableId).add(name);
      }
      await tx.relation.update({
        where: { id: found.id },
        data: {
          name,
          constraintName: side.constraintName,
          fromTableId: side.tableId,
          fromColumns: side.columns,
          toTableId: side.otherId,
          toColumns: side.otherColumns,
          missingSince: null,
        },
      });
    }
  }
  const newlyMissingRelationIds = existingDiscovered
    .filter((r) => !claimed.has(r.id) && r.missingSince === null)
    .map((r) => r.id);
  summary.relations.missing = newlyMissingRelationIds.length;
  for (const rows of chunks(newRelations)) {
    await tx.relation.createMany({ data: rows });
  }
  for (const ids of chunks(newlyMissingRelationIds)) {
    await tx.relation.updateMany({
      where: { id: { in: ids } },
      data: { missingSince: now },
    });
  }
  return summary;
};

/**
 * Reads the source's schema and brings the catalogue up to date with it.
 *
 * The snapshot is read before any transaction, so no database connection is
 * held while the source answers. The write then takes an advisory lock keyed
 * on the source, which makes concurrent refreshes apply one after another. A
 * snapshot read before another refresh landed could be the older of the two,
 * and one read before the source's settings or schemas changed describes the
 * old target, so after taking the lock the write checks that
 * `last_refreshed_at` and `updated_at` still have the values seen before the
 * read, and reads again when either does not. The catalogue therefore ends
 * matching the newest read of the current settings.
 */
export const refreshSource = async (
  sourceId: string,
  actorId: string
): Promise<RefreshSummary> => {
  for (let round = 1; ; round++) {
    const row = await db.sources.findById(sourceId);
    if (!row) throw new NotFoundError("Source not found");
    if (row.archivedAt) throw new SourceArchivedError();
    const snapshot = await readSnapshot(row);
    const lastRound = round >= MAX_READ_ROUNDS;

    const summary = await withAudit(
      async (tx, audit) => {
        await lockSourceCatalog(tx, sourceId);
        const current = await tx.source.findUnique({ where: { id: sourceId } });
        if (!current) throw new NotFoundError("Source not found");
        if (current.archivedAt) throw new SourceArchivedError();
        if (
          !lastRound &&
          (current.lastRefreshedAt?.getTime() !==
            row.lastRefreshedAt?.getTime() ||
            current.updatedAt.getTime() !== row.updatedAt.getTime())
        ) {
          return null;
        }
        const result = await applySnapshot(tx, sourceId, snapshot);
        // Strictly later than the last value, so the check above notices every apply.
        const next = new Date(
          Math.max(Date.now(), (current.lastRefreshedAt?.getTime() ?? 0) + 1)
        );
        await tx.source.update({
          where: { id: sourceId },
          data: { status: "active", lastRefreshedAt: next },
        });
        audit({
          action: AUDIT_EVENTS.sourceRefreshed,
          resourceType: "source",
          resourceId: sourceId,
          actorId,
          metadata: { slug: current.slug, type: typeOf(current), ...result },
        });
        return result;
      },
      { timeoutMs: REFRESH_TRANSACTION_TIMEOUT_MS }
    );
    if (summary) return summary;
    logger.info(
      { source_id: sourceId, round },
      "the source changed or another refresh landed during the read; reading again"
    );
  }
};

/**
 * Refreshes a source right after it was created or its settings or schemas
 * changed. The change stands whether or not the read works (the status says
 * which), so a failure is logged, not thrown.
 */
export const refreshAfterChange = async (
  sourceId: string,
  actorId: string
): Promise<void> => {
  try {
    await refreshSource(sourceId, actorId);
  } catch (err) {
    const expected =
      err instanceof SourceUnreachableError ||
      err instanceof HostNotAllowedError;
    logger[expected ? "warn" : "error"](
      { err, source_id: sourceId },
      "catalogue refresh after a change failed"
    );
  }
};
