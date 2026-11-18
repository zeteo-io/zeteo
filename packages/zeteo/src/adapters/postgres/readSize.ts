import { userSchemas } from "./loginCheck.js";
import type { Pool } from "pg";

// Tables and materialized views; a partition is a table of its own, and a
// partitioned parent ('p') holds no data, so nothing is counted twice.
const SIZE = `
  SELECT COALESCE(SUM(pg_catalog.pg_total_relation_size(c.oid)), 0)::int8 AS bytes
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'm')`;

/** The listed schemas' tables on disk, indexes and TOAST included; throws as the driver does. */
export const readSize = async (
  pool: Pool,
  schemas: string[]
): Promise<number> => {
  const listed = userSchemas(schemas);
  if (listed.length === 0) return 0;
  const result = await pool.query<{ bytes: string }>(SIZE, [listed]);
  return Number(result.rows[0]?.bytes ?? 0);
};
