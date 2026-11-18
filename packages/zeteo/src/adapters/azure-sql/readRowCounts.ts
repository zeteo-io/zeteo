import type { TableRowCount } from "../types.js";
import { userSchemas } from "./readSchema.js";
import type { ConnectionPool } from "mssql";
import sql from "mssql";

/**
 * The user tables of the listed schemas (each a bound parameter, matched
 * exactly whatever the collation) and their rows as sys.partitions keeps
 * them: the heap (index 0) or the clustered index (1), summed over the
 * partitions. A catalogue view, so no VIEW DATABASE STATE is needed; it shows
 * only the tables the login has some permission on. Views are left out.
 */
const rowCounts = (count: number) => `
  SELECT s.name AS schema_name, o.name AS table_name,
         SUM(CAST(p.rows AS bigint)) AS row_count
    FROM sys.partitions p
    JOIN sys.objects o ON o.object_id = p.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
   WHERE p.index_id IN (0, 1)
     AND o.type = 'U'
     AND o.is_ms_shipped = 0
     AND s.name COLLATE Latin1_General_BIN2 IN (${Array.from({ length: count }, (_, i) => `@s${i}`).join(", ")})
   GROUP BY s.name, o.name`;

/** The listed schemas' user tables' rows; throws as the driver does. */
export const readRowCounts = async (
  pool: ConnectionPool,
  schemas: string[]
): Promise<TableRowCount[]> => {
  const listed = userSchemas(schemas);
  if (listed.length === 0) return [];
  const request = pool.request();
  listed.forEach((name, i) => request.input(`s${i}`, sql.NVarChar(128), name));
  const result = await request.query<{
    schema_name: string;
    table_name: string;
    row_count: string | number;
  }>(rowCounts(listed.length));
  return result.recordset.map((r) => ({
    schemaName: r.schema_name,
    name: r.table_name,
    rows: Number(r.row_count),
  }));
};
