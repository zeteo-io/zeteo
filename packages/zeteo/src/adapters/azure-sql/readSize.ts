import { userSchemas } from "./readSchema.js";
import type { ConnectionPool } from "mssql";
import sql from "mssql";

/** SQL Server's "permission denied" errors: 297 (the user does not have permission) and 300 (a permission, VIEW DATABASE STATE among them, was denied). */
const PERMISSION_DENIED = new Set([297, 300]);

/** Whether the driver's error is SQL Server refusing a permission. */
export const isPermissionDenied = (err: unknown): boolean => {
  const number =
    (err as { number?: unknown } | null)?.number ??
    (err as { originalError?: { info?: { number?: unknown } } } | null)
      ?.originalError?.info?.number;
  return typeof number === "number" && PERMISSION_DENIED.has(number);
};

/**
 * The listed schemas (each a bound parameter, matched exactly whatever the
 * collation) and their user tables' used pages, heaps, indexes and LOB data
 * alike. sys.dm_db_partition_stats needs VIEW DATABASE STATE.
 */
const size = (count: number) => `
  SELECT CAST(COALESCE(SUM(CAST(ps.used_page_count AS bigint)), 0) * 8192 AS bigint) AS bytes
    FROM sys.dm_db_partition_stats ps
    JOIN sys.objects o ON o.object_id = ps.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
   WHERE o.type = 'U'
     AND o.is_ms_shipped = 0
     AND s.name COLLATE Latin1_General_BIN2 IN (${Array.from({ length: count }, (_, i) => `@s${i}`).join(", ")})`;

/** The listed schemas' user tables on disk; throws as the driver does. */
export const readSize = async (
  pool: ConnectionPool,
  schemas: string[]
): Promise<number> => {
  const listed = userSchemas(schemas);
  if (listed.length === 0) return 0;
  const request = pool.request();
  listed.forEach((name, i) => request.input(`s${i}`, sql.NVarChar(128), name));
  const result = await request.query<{ bytes: string | number }>(
    size(listed.length)
  );
  return Number(result.recordset[0]?.bytes ?? 0);
};
