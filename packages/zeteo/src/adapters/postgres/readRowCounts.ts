import type { TableRowCount } from "../types.js";
import { userSchemas } from "./loginCheck.js";
import type { Pool } from "pg";

// The catalogue's tables and materialized views ('r', 'm') with their
// planner estimate, and its partitioned tables ('p') with the sum of their
// leaf partitions' (a parent holds no rows of its own). Partitions are left
// out, as the catalogue leaves them out. reltuples is -1 for a relation never
// vacuumed or analyzed, which autovacuum never does for a small table loaded
// once (it waits for 50 rows plus 10% to change); such a relation falls back
// to the statistics collector's live-row count, kept on every write. That
// count is 0 on a read replica and after a crash, so a 0 there is no
// estimate. A parent with any leaf left without one has none either. Views
// ('v') have no rows to estimate.
const ESTIMATE = (rel: string) => `
  CASE WHEN ${rel}.reltuples >= 0 THEN ${rel}.reltuples
       ELSE NULLIF(pg_catalog.pg_stat_get_live_tuples(${rel}.oid), 0) END`;

const ROW_COUNTS = `
  SELECT n.nspname, c.relname,
         CASE WHEN c.relkind = 'p' THEN (
           SELECT CASE WHEN bool_or((${ESTIMATE("l")}) IS NULL) THEN NULL
                       ELSE COALESCE(SUM(${ESTIMATE("l")}), 0) END
             FROM pg_catalog.pg_partition_tree(c.oid) pt
             JOIN pg_catalog.pg_class l ON l.oid = pt.relid
            WHERE pt.isleaf)
         ELSE ${ESTIMATE("c")} END::float8 AS rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'm', 'p')
     AND NOT c.relispartition`;

/** The listed schemas' tables' estimated rows, those without one left out; throws as the driver does. */
export const readRowCounts = async (
  pool: Pool,
  schemas: string[]
): Promise<TableRowCount[]> => {
  const listed = userSchemas(schemas);
  if (listed.length === 0) return [];
  const result = await pool.query<{
    nspname: string;
    relname: string;
    rows: number | null;
  }>(ROW_COUNTS, [listed]);
  return result.rows
    .filter((r) => r.rows !== null && r.rows >= 0)
    .map((r) => ({
      schemaName: r.nspname,
      name: r.relname,
      rows: Math.round(r.rows!),
    }));
};
