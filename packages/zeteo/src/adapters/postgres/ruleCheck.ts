import { postgresDialect } from "../sql/dialects/postgres.js";
import type { RowRuleAt, TableName } from "../sql/types.js";
import type { RuledReadInfo } from "../sql/compile.js";
import { NATIVE_TYPE } from "./readSchema.js";
import type { PoolClient } from "pg";
import { sql } from "kysely";

// What the catalogue says of a table may be stale: it was read at the last
// refresh. Before a rule-limited query runs, in its own read-only
// transaction and on its own client, each table it reads through a rule is
// locked and its metadata read, never its rows, so DDL cannot land between
// the check and the query. The outcome depends on that metadata alone.

/** A read of a table through its row rule, as the compiler reports it. */
export type RuledTableRead = RuledReadInfo;

/** A table as its metadata says it is now. */
export interface LiveTable {
  /** `pg_class.relkind`: `r` table, `p` partitioned, `v` view, `m` materialized, `f` foreign. */
  kind: string;
  /**
   * Whether it and every descendant (partition or inheritance child) is a
   * table or partitioned table with no virtual generated column (PostgreSQL
   * 18 computes one when read, so it can raise per row).
   */
  plain: boolean;
  /**
   * Whether row-level security is on for it or a descendant: the planner may
   * evaluate a leakproof condition of the caller's before a policy's, which
   * could then raise on rows the caller picked.
   */
  rowSecurity: boolean;
  /**
   * The columns asked for whose collation is nondeterministic, where ILIKE
   * (a rule's `contains` or `startsWith`) raises on each row it reads.
   */
  nondeterministic: ReadonlySet<string>;
  /** The type of each column asked for, as the catalogue refresh writes it (`NATIVE_TYPE`). */
  columns: ReadonlyMap<string, string>;
}

export const tableKey = (t: TableName): string =>
  JSON.stringify([t.schemaName, t.name]);

/** One read per table: every column once (by name and type), narrowed if any read was, the first read's place. */
export const mergeRuledReads = (
  reads: readonly RuledTableRead[]
): RuledTableRead[] => {
  const byTable = new Map<string, RuledTableRead>();
  for (const r of reads) {
    const key = tableKey(r);
    const seen = byTable.get(key);
    if (!seen) {
      byTable.set(key, { ...r, columns: [...r.columns] });
      continue;
    }
    const columns = new Map(
      [...seen.columns, ...r.columns].map((c) => [
        JSON.stringify([c.name, c.nativeType]),
        c,
      ])
    );
    byTable.set(key, {
      ...seen,
      narrowed: seen.narrowed || r.narrowed,
      onView: seen.onView || r.onView,
      columns: [...columns.values()],
    });
  }
  return [...byTable.values()].map((r) => ({
    ...r,
    columns: [...r.columns].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.nativeType.localeCompare(b.nativeType)
    ),
  }));
};

/**
 * What the query may do, from each table's metadata: refused (`409
 * row_rule_unavailable` where `at` says), when a table has gone or a column
 * its rule or a condition beside it compares has gone or another type than
 * the catalogue's; else run, each table in `unnarrowed` read with its rule
 * alone, compiled again when one of them had conditions beside it.
 */
export type RuleCheckOutcome =
  | { kind: "refuse"; at: RowRuleAt | undefined }
  | { kind: "run"; unnarrowed: ReadonlySet<string>; recompile: boolean };

const PUSHDOWN_KINDS = new Set(["r", "p"]);

export const decideRuledReads = (
  reads: readonly RuledTableRead[],
  live: ReadonlyMap<string, LiveTable>
): RuleCheckOutcome => {
  const unnarrowed = new Set<string>();
  let recompile = false;
  for (const r of mergeRuledReads(reads)) {
    const key = tableKey(r);
    const table = live.get(key);
    if (
      !table ||
      r.columns.some((c) => table.columns.get(c.name) !== c.nativeType)
    ) {
      return { kind: "refuse", at: r.at };
    }
    if (
      !PUSHDOWN_KINDS.has(table.kind) ||
      !table.plain ||
      table.rowSecurity ||
      r.columns.some((c) => table.nondeterministic.has(c.name))
    ) {
      unnarrowed.add(key);
      if (r.narrowed) recompile = true;
    }
  }
  return { kind: "run", unnarrowed, recompile };
};

/**
 * The statements that lock each ruled table in ACCESS SHARE mode, what the
 * query itself takes, until the transaction ends, so no DDL lands between the
 * check and the query. LOCK TABLE ONLY (allowed in a read-only transaction in
 * this mode) locks the table alone: locking its partitions and inheritance
 * children adds nothing the check relies on (a child cannot change an
 * inherited column's type or its own kind alone, nor gain a virtual column
 * its parent lacks; detaching one needs the parent's lock; one attached
 * concurrently races either way), and on older servers would need a
 * privilege on each. It refuses a materialized view or a foreign table: one the
 * catalogue holds as a table and now is one is refused with the query
 * (wrong object type), as a stale catalogue. One the catalogue holds as a
 * view (a view or a materialized view) is locked by a select of no row,
 * which takes the same lock on it and on what a view reads, planned as a
 * constant false and reading nothing. Identifiers only, quoted.
 */
export const lockStatements = (reads: readonly RuledTableRead[]): string[] =>
  mergeRuledReads(reads).map((r) => {
    const name = sql.id(r.schemaName, r.name);
    const statement = r.onView
      ? sql`select from ${name} where false`
      : sql`lock table only ${name} in access share mode`;
    return statement.compile(postgresDialect.kysely).sql;
  });

/**
 * Each wanted table's kind, whether it and its descendants are plain and
 * whether row-level security is on for any of them, and the named columns'
 * types and whether their collation is nondeterministic. Metadata only;
 * `attgenerated` and `collisdeterministic` exist from PostgreSQL 12, which a
 * rule-limited query already needs.
 */
const LIVE_TABLES = `
  WITH RECURSIVE wanted AS (
    SELECT e.i, c.oid, c.relkind
      FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS e(s, r, i)
      JOIN pg_catalog.pg_namespace n ON n.nspname = e.s
      JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = e.r
  ), members AS (
    SELECT w.i, w.oid FROM wanted w
    UNION
    SELECT m.i, h.inhrelid FROM members m
      JOIN pg_catalog.pg_inherits h ON h.inhparent = m.oid
  )
  SELECT w.i::int4 AS i, w.relkind::text AS kind,
         NOT EXISTS (
           SELECT 1 FROM members m
             JOIN pg_catalog.pg_class mc ON mc.oid = m.oid
            WHERE m.i = w.i
              AND (mc.relkind NOT IN ('r', 'p')
                   OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute g
                               WHERE g.attrelid = m.oid AND g.attnum > 0
                                 AND NOT g.attisdropped AND g.attgenerated = 'v'))
         ) AS plain,
         EXISTS (
           SELECT 1 FROM members m
             JOIN pg_catalog.pg_class mc ON mc.oid = m.oid
            WHERE m.i = w.i AND mc.relrowsecurity
         ) AS row_security,
         a.attname::text AS column_name,
         ${NATIVE_TYPE} AS native_type,
         EXISTS (SELECT 1 FROM pg_catalog.pg_collation co
                  WHERE co.oid = a.attcollation AND NOT co.collisdeterministic)
           AS nondeterministic
    FROM wanted w
    LEFT JOIN pg_catalog.pg_attribute a
      ON a.attrelid = w.oid AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname = ANY($3::text[])
    LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype`;

/** Reads each ruled table's metadata on `client`, inside the query's transaction, after `lockStatements`. */
export const readLiveTables = async (
  client: PoolClient,
  reads: readonly RuledTableRead[]
): Promise<Map<string, LiveTable>> => {
  const tables = mergeRuledReads(reads);
  const names = [
    ...new Set(tables.flatMap((t) => t.columns.map((c) => c.name))),
  ];
  const { rows } = await client.query<{
    i: number;
    kind: string;
    plain: boolean;
    row_security: boolean;
    column_name: string | null;
    native_type: string | null;
    nondeterministic: boolean;
  }>(LIVE_TABLES, [
    tables.map((t) => t.schemaName),
    tables.map((t) => t.name),
    names,
  ]);
  const live = new Map<string, LiveTable>();
  for (const row of rows) {
    const key = tableKey(tables[row.i - 1]!);
    let table = live.get(key);
    if (!table) {
      table = {
        kind: row.kind,
        plain: row.plain,
        rowSecurity: row.row_security,
        nondeterministic: new Set(),
        columns: new Map(),
      };
      live.set(key, table);
    }
    if (row.column_name !== null && row.native_type !== null) {
      (table.columns as Map<string, string>).set(
        row.column_name,
        row.native_type
      );
      if (row.nondeterministic) {
        (table.nondeterministic as Set<string>).add(row.column_name);
      }
    }
  }
  return live;
};
