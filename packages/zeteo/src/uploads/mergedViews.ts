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

/** The member column name a merged column maps from, as its catalogue row keeps it. */
export const fromNameOf = (c: { originalName: string | null; name: string }) =>
  c.originalName ?? c.name;

/** A text merged column takes any member type; another takes its own only. */
const fits = (merged: ColumnType, member: ColumnType) =>
  merged === "text" || merged === member;

/**
 * The live column of `member` a merged column reads, from its id in the
 * definition; a column back under a new id (it went missing and was added
 * again) is found by the name its old row had. With no id (the member did
 * not have the column when it was chosen), a live column named `fromName` is
 * taken.
 */
export const resolveMemberColumn = (
  member: CatalogTable,
  type: ColumnType,
  fromId: string | undefined,
  fromName?: string
): MemberColumn => {
  if (fromId === undefined) {
    // A member that gains the column later: its live column of that name.
    const gained =
      fromName === undefined
        ? undefined
        : member.columns.find(
            (c) => c.missingSince === null && c.name === fromName
          );
    if (!gained) return { state: "none" };
    return fits(type, gained.type)
      ? { state: "fits", column: gained }
      : { state: "unfit", column: gained };
  }
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

/** The tables a change of stored tables touches, or all the source's. */
export type Touched = readonly string[] | "all";

/** The source's live merged tables that are in `touched` or read a table in it. */
const dependents = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  touched: Touched
): Promise<CatalogTable[]> => {
  if (touched !== "all" && touched.length === 0) return [];
  const merged = await tx.sourceTable.findMany({
    where: {
      sourceId,
      missingSince: null,
      origin: { path: ["kind"], equals: "merged" },
    },
    include: { columns: true },
    orderBy: { name: "asc" },
  });
  if (touched === "all") return merged;
  const ids = new Set(touched);
  return merged.filter((t) => {
    if (ids.has(t.id)) return true;
    const origin = originOf(t);
    return (
      origin?.kind === "merged" &&
      origin.definition.members.some((m) => ids.has(m.tableId))
    );
  });
};

/** Drops the views of `tables`, or, for `"all"`, every view in the source's schema. */
const dropViews = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  touched: Touched,
  tables: CatalogTable[]
) => {
  const schema = schemaFor(sourceId);
  const names =
    touched === "all"
      ? (
          await tx.$queryRaw<{ viewname: string }[]>`
            SELECT viewname FROM pg_views WHERE schemaname = ${schema}
            ORDER BY viewname`
        ).map((v) => v.viewname)
      : tables.map((t) => t.name);
  for (const name of names) {
    await tx.$executeRawUnsafe(
      `DROP VIEW IF EXISTS ${quote(schema)}.${quote(name)}`
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
      const r = resolveMemberColumn(
        member,
        c.type,
        c.from[member.id],
        fromNameOf(catalog)
      );
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

/** Creates the views of `merged` (live merged tables of the source) from the catalogue. */
const rebuild = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  merged: CatalogTable[]
) => {
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
 * Creates the views of the source's live merged tables of `ids` (a merged
 * table just created, whose view nothing has dropped).
 */
export const createMergedViews = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  ids: string[]
): Promise<void> => {
  const merged = await dependents(tx, sourceId, ids);
  await rebuild(
    tx,
    sourceId,
    merged.filter((t) => ids.includes(t.id))
  );
};

/**
 * Runs `fn`, a change of the stored tables `touched` (their ids; a merged
 * table's own id when it is the one changed; `"all"` for the whole source),
 * in `tx` with the merged views that depend on them out of the way: drops
 * the views of the live merged tables in `touched` or reading a table in it,
 * runs `fn`, then creates them again from the catalogue `fn` left (members
 * missing left out; member columns gone or no longer fitting give NULL and a
 * warning) and grants the reader SELECT. Other merged views are left alone,
 * so a query on one never holds up a change of tables it does not read.
 */
export const withMergedViews = async <T>(
  tx: Prisma.TransactionClient,
  sourceId: string,
  touched: Touched,
  fn: () => Promise<T>
): Promise<T> => {
  const before = await dependents(tx, sourceId, touched);
  await dropViews(tx, sourceId, touched, before);
  const result = await fn();
  await rebuild(tx, sourceId, await dependents(tx, sourceId, touched));
  return result;
};
