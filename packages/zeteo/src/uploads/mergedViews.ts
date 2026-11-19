import { emptyMergedViewSql, mergedViewSql } from "./mergedSql.js";
import { originOf, type MergedDefinition } from "./origin.js";
import type { ColumnType } from "../adapters/types.js";
import type { Prisma } from "../utils/db/prisma.js";
import type { UploadColumnType } from "./types.js";
import { readerRoleName } from "./readerRole.js";
import { quote, schemaFor } from "./storage.js";
import { logger } from "../utils/logger.js";
import type {
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";

/**
 * A merged table is a view in its source's `zu_` schema over the member
 * tables. Postgres refuses to drop or rename a table a view reads, so every
 * transaction that drops or swaps a stored table of an upload source runs
 * inside `withMergedViews`: the source's views are dropped first, the change
 * runs, then each live merged table's view is created again from the
 * catalogue as the change left it. Identifiers come from catalogue rows and
 * labels are escaped literals (`mergedSql.ts`).
 */

export type CatalogTable = SourceTable & { columns: SourceColumn[] };

/** What a member gives a merged column. */
export type MemberColumn =
  /** The member never had the column: NULL, nothing to say. */
  | { state: "none" }
  /** The member's column is gone: NULL, and a warning. */
  | { state: "gone" }
  /** The member's column no longer fits the merged type: NULL, and a warning. */
  | { state: "unfit"; column: SourceColumn }
  | { state: "fits"; column: SourceColumn };

/** A text merged column takes any member type; another takes its own only. */
const fits = (merged: ColumnType, member: ColumnType) =>
  merged === "text" || merged === member;

/**
 * The live column of `member` a merged column reads, from its id in the
 * definition; a column back under a new id (it went missing and was added
 * again) is found by the name its old row had.
 */
export const resolveMemberColumn = (
  member: CatalogTable,
  type: ColumnType,
  fromId: string | undefined
): MemberColumn => {
  if (fromId === undefined) return { state: "none" };
  const byId = member.columns.find((c) => c.id === fromId);
  const column =
    byId && byId.missingSince === null
      ? byId
      : byId &&
        member.columns.find(
          (c) => c.missingSince === null && c.name === byId.name
        );
  if (!column) return { state: "gone" };
  return fits(type, column.type)
    ? { state: "fits", column }
    : { state: "unfit", column };
};

/** True for a table a merged table may read now: live, and a stored table. */
export const isLiveMember = (table: SourceTable | undefined) =>
  table !== undefined && table.missingSince === null && table.kind === "table";

/** Drops every view in the source's schema (only merged tables are views there). */
const dropMergedViews = async (
  tx: Prisma.TransactionClient,
  sourceId: string
) => {
  const schema = schemaFor(sourceId);
  const views = await tx.$queryRaw<{ viewname: string }[]>`
    SELECT viewname FROM pg_views WHERE schemaname = ${schema}`;
  for (const v of views) {
    await tx.$executeRawUnsafe(
      `DROP VIEW IF EXISTS ${quote(schema)}.${quote(v.viewname)}`
    );
  }
};

/**
 * Creates one merged table's view from the catalogue, and records what it
 * found: member columns gone or no longer fitting (`warnings`), selected
 * columns no live member has (`missing_since`, cleared when one has it
 * again), a column back under a new id (`from`), and the row count (the sum
 * of its live members').
 */
const rebuildOne = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  table: CatalogTable,
  members: Map<string, CatalogTable>,
  now: Date
) => {
  const origin = originOf(table);
  if (origin?.kind !== "merged") return;
  const def = origin.definition;
  const own = new Map(table.columns.map((c) => [c.id, c]));
  const label = own.get(def.labelColumnId);
  if (!label) {
    logger.error(
      { source_id: sourceId, table_id: table.id },
      "a merged table has no label column; its view is not created"
    );
    return;
  }
  const live = def.members.flatMap((m) => {
    const t = members.get(m.tableId);
    return t && isLiveMember(t) ? [{ label: m.label, table: t }] : [];
  });

  const warnings: NonNullable<MergedDefinition["warnings"]> = [];
  const columns: MergedDefinition["columns"] = [];
  const shown: { name: string; type: UploadColumnType }[] = [];
  const names: (string | null)[][] = live.map(() => []);
  for (const c of def.columns) {
    const catalog = own.get(c.columnId);
    if (!catalog) continue;
    const from = { ...c.from };
    let provided = false;
    live.forEach(({ table: member }, i) => {
      const r = resolveMemberColumn(member, c.type, c.from[member.id]);
      if (r.state === "none") {
        names[i]!.push(null);
        return;
      }
      if (r.state === "gone") {
        warnings.push({ columnId: c.columnId, tableId: member.id });
        names[i]!.push(null);
        return;
      }
      provided = true;
      from[member.id] = r.column.id;
      if (r.state === "unfit") {
        warnings.push({ columnId: c.columnId, tableId: member.id });
        names[i]!.push(null);
      } else {
        names[i]!.push(r.column.name);
      }
    });
    columns.push({ ...c, from });
    shown.push({ name: catalog.name, type: c.type as UploadColumnType });
    if (provided && catalog.missingSince !== null) {
      await tx.sourceColumn.update({
        where: { id: catalog.id },
        data: { missingSince: null },
      });
    } else if (!provided && catalog.missingSince === null) {
      await tx.sourceColumn.update({
        where: { id: catalog.id },
        data: { missingSince: now },
      });
    }
  }

  const schema = schemaFor(sourceId);
  const sql =
    live.length === 0
      ? emptyMergedViewSql(schema, table.name, {
          labelColumn: label.name,
          columns: shown,
        })
      : mergedViewSql(schema, table.name, {
          labelColumn: label.name,
          columns: shown,
          members: live.map((m, i) => ({
            physicalTable: m.table.name,
            label: m.label,
            columnNames: names[i]!,
          })),
        });
  await tx.$executeRawUnsafe(sql);
  await tx.$executeRawUnsafe(
    `GRANT SELECT ON ${quote(schema)}.${quote(table.name)} TO ${quote(readerRoleName())}`
  );
  const rowCount = live.reduce(
    (sum, m) => sum + (m.table.rowCount ?? BigInt(0)),
    BigInt(0)
  );
  await tx.sourceTable.update({
    where: { id: table.id },
    data: {
      rowCount,
      origin: {
        kind: "merged",
        definition: { ...def, columns, warnings },
      },
    },
  });
};

/** Creates the view of every live merged table of the source from the catalogue. */
const rebuildMergedViews = async (
  tx: Prisma.TransactionClient,
  sourceId: string
) => {
  const merged = await tx.sourceTable.findMany({
    where: {
      sourceId,
      missingSince: null,
      origin: { path: ["kind"], equals: "merged" },
    },
    include: { columns: true },
    orderBy: { name: "asc" },
  });
  if (merged.length === 0) return;
  const memberIds = new Set<string>();
  for (const t of merged) {
    const origin = originOf(t);
    if (origin?.kind !== "merged") continue;
    for (const m of origin.definition.members) memberIds.add(m.tableId);
  }
  const members = await tx.sourceTable.findMany({
    where: { sourceId, id: { in: [...memberIds] } },
    include: { columns: true },
  });
  const byId = new Map(members.map((t) => [t.id, t]));
  const now = new Date();
  for (const t of merged) await rebuildOne(tx, sourceId, t, byId, now);
};

/**
 * Runs `fn`, a change of the source's stored tables or of its catalogue, in
 * `tx` with the source's merged views out of the way: drops them all, runs
 * `fn`, then creates each live merged table's view again from the
 * catalogue `fn` left (members missing left out; member columns gone or no
 * longer fitting give NULL and a warning) and grants the reader SELECT.
 */
export const withMergedViews = async <T>(
  tx: Prisma.TransactionClient,
  sourceId: string,
  fn: () => Promise<T>
): Promise<T> => {
  await dropMergedViews(tx, sourceId);
  const result = await fn();
  await rebuildMergedViews(tx, sourceId);
  return result;
};
