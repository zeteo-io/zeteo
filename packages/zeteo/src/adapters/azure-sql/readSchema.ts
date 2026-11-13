import { azureSqlNativeType, mapAzureSqlType } from "./types.js";
import type { ConnectionPool } from "mssql";
import sql from "mssql";
import type {
  SchemaSnapshot,
  SnapshotForeignKey,
  SnapshotTable,
} from "../types.js";

/** Schemas SQL Server ships, never read. Compared case-insensitively, as the default collation does. */
const SYSTEM_SCHEMAS = new Set(
  [
    "sys",
    "INFORMATION_SCHEMA",
    "guest",
    "db_owner",
    "db_accessadmin",
    "db_securityadmin",
    "db_ddladmin",
    "db_backupoperator",
    "db_datareader",
    "db_datawriter",
    "db_denydatareader",
    "db_denydatawriter",
  ].map((name) => name.toLowerCase())
);

/** Listed schemas without the system ones. */
export const userSchemas = (schemas: string[]): string[] =>
  schemas.filter((name) => !SYSTEM_SCHEMAS.has(name.toLowerCase()));

/**
 * The listed schemas, each a bound parameter (`@s0`, `@s1`, …: names made
 * from the index, never from the input), matched exactly whatever the
 * database's collation, and never one SQL Server ships.
 */
const listedSchemas = (count: number) => `
  SELECT s.schema_id, s.name FROM sys.schemas s
   WHERE s.name COLLATE Latin1_General_BIN2 IN (${Array.from({ length: count }, (_, i) => `@s${i}`).join(", ")})
     AND s.schema_id NOT IN (2, 3, 4)
     AND s.schema_id NOT BETWEEN 16384 AND 16399`;

// Tables and views in the listed schemas that the login can select from.
const visible = (count: number) => `
  WITH listed AS (${listedSchemas(count)})
  SELECT o.object_id, l.name AS schema_name, o.name, o.type
    INTO #visible
    FROM sys.objects o
    JOIN listed l ON l.schema_id = o.schema_id
   WHERE o.type IN ('U', 'V')
     AND o.is_ms_shipped = 0
     AND HAS_PERMS_BY_NAME(QUOTENAME(l.name) + N'.' + QUOTENAME(o.name), N'OBJECT', N'SELECT') = 1`;

const RELATIONS = `
  SELECT object_id, schema_name, name, RTRIM(type) AS type
    FROM #visible ORDER BY schema_name, name`;

// Alias types report their base type; CLR types (geography, hierarchyid, …)
// their own name.
const COLUMNS = `
  SELECT c.object_id, c.name,
         CAST(ROW_NUMBER() OVER (PARTITION BY c.object_id ORDER BY c.column_id) AS int) AS position,
         CASE WHEN t.is_user_defined = 1 AND t.is_assembly_type = 0
              THEN TYPE_NAME(c.system_type_id) ELSE t.name END AS type_name,
         CAST(c.max_length AS int) AS max_length,
         CAST(c.precision AS int) AS precision,
         CAST(c.scale AS int) AS scale,
         c.is_nullable,
         CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS is_primary_key
    FROM #visible v
    JOIN sys.columns c ON c.object_id = v.object_id
    JOIN sys.types t ON t.user_type_id = c.user_type_id
    LEFT JOIN (
      SELECT ic.object_id, ic.column_id
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       WHERE i.is_primary_key = 1
    ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
   ORDER BY v.schema_name, v.name, c.column_id`;

// One row per key column; both ends must be visible.
const FOREIGN_KEYS = `
  SELECT fk.name AS constraint_name, fk.object_id AS constraint_id,
         f.schema_name AS from_schema, f.name AS from_table,
         t.schema_name AS to_schema, t.name AS to_table,
         fc.name AS from_column, tc.name AS to_column
    FROM sys.foreign_keys fk
    JOIN #visible f ON f.object_id = fk.parent_object_id
    JOIN #visible t ON t.object_id = fk.referenced_object_id
    JOIN sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
    JOIN sys.columns fc ON fc.object_id = k.parent_object_id AND fc.column_id = k.parent_column_id
    JOIN sys.columns tc ON tc.object_id = k.referenced_object_id AND tc.column_id = k.referenced_column_id
   ORDER BY f.schema_name, f.name, fk.name, k.constraint_column_id`;

/**
 * Reads the listed schemas in one batch on one connection: the temporary
 * table of visible relations is the connection's own and is dropped with the
 * batch's last statement.
 */
export const readSchema = async (
  pool: ConnectionPool,
  schemas: string[]
): Promise<SchemaSnapshot> => {
  const listed = userSchemas(schemas);
  if (listed.length === 0) return { tables: [], foreignKeys: [] };

  const request = pool.request();
  listed.forEach((name, i) => request.input(`s${i}`, sql.NVarChar(128), name));
  const result = await request.query(`
    SET NOCOUNT ON;
    ${visible(listed.length)};
    ${RELATIONS};
    ${COLUMNS};
    ${FOREIGN_KEYS};
    DROP TABLE #visible;`);
  const [relations, columns, keys] = result.recordsets as unknown as [
    { object_id: number; schema_name: string; name: string; type: string }[],
    {
      object_id: number;
      name: string;
      position: number;
      type_name: string;
      max_length: number;
      precision: number;
      scale: number;
      is_nullable: boolean;
      is_primary_key: boolean;
    }[],
    {
      constraint_name: string;
      constraint_id: number;
      from_schema: string;
      from_table: string;
      to_schema: string;
      to_table: string;
      from_column: string;
      to_column: string;
    }[],
  ];

  const byId = new Map<number, SnapshotTable>();
  for (const row of relations) {
    byId.set(row.object_id, {
      schemaName: row.schema_name,
      name: row.name,
      kind: row.type === "V" ? "view" : "table",
      columns: [],
    });
  }
  for (const row of columns) {
    byId.get(row.object_id)?.columns.push({
      name: row.name,
      type: mapAzureSqlType(row.type_name),
      nativeType: azureSqlNativeType({
        name: row.type_name,
        maxLength: row.max_length,
        precision: row.precision,
        scale: row.scale,
      }),
      nullable: row.is_nullable,
      position: row.position,
      isPrimaryKey: row.is_primary_key,
    });
  }
  const foreignKeys = new Map<number, SnapshotForeignKey>();
  for (const row of keys) {
    const key = foreignKeys.get(row.constraint_id) ?? {
      constraintName: row.constraint_name,
      from: { schemaName: row.from_schema, table: row.from_table, columns: [] },
      to: { schemaName: row.to_schema, table: row.to_table, columns: [] },
    };
    key.from.columns.push(row.from_column);
    key.to.columns.push(row.to_column);
    foreignKeys.set(row.constraint_id, key);
  }
  return { tables: [...byId.values()], foreignKeys: [...foreignKeys.values()] };
};
