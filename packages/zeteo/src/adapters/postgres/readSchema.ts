import { userSchemas } from "./loginCheck.js";
import { mapPostgresType } from "./types.js";
import type { Pool } from "pg";
import type {
  SchemaSnapshot,
  SnapshotForeignKey,
  SnapshotTable,
} from "../types.js";

// Relations in the listed schemas that the login can reach and read.
// Partitions are left out: the partitioned parent stands for them.
const VISIBLE = `
  c.relkind IN ('r', 'p', 'v', 'm')
  AND NOT c.relispartition
  AND n.nspname = ANY($1::text[])
  AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
  AND pg_catalog.has_table_privilege(c.oid, 'SELECT')`;

const RELATIONS = `
  SELECT c.oid::int8 AS oid, n.nspname, c.relname, c.relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${VISIBLE}
   ORDER BY n.nspname, c.relname`;

// The type as Postgres writes it, with what a dialect must know and the name
// cannot tell: an enum is marked ` (enum)`, a domain `(domain over <base>)`.
// A quoted name ends in `"`, so neither mark can be part of a name.
const NATIVE_TYPE = `
  CASE t.typtype
    WHEN 'e' THEN pg_catalog.format_type(a.atttypid, a.atttypmod) || ' (enum)'
    WHEN 'd' THEN pg_catalog.format_type(a.atttypid, a.atttypmod)
      || ' (domain over ' || pg_catalog.format_type(t.typbasetype, t.typtypmod)
      || CASE WHEN bt.typtype = 'e' THEN ' (enum)' ELSE '' END || ')'
    ELSE pg_catalog.format_type(a.atttypid, a.atttypmod)
  END`;

const COLUMNS = `
  SELECT c.oid::int8 AS oid, a.attname,
         row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum)::int4 AS position,
         ${NATIVE_TYPE} AS native_type,
         t.typname, t.typtype, bt.typname AS base_typname, bt.typtype AS base_typtype,
         NOT a.attnotnull AS nullable,
         COALESCE(a.attnum = ANY (pk.conkey), false) AS is_primary_key
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
    LEFT JOIN pg_catalog.pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
   WHERE ${VISIBLE}
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY n.nspname, c.relname, a.attnum`;

const FOREIGN_KEYS = `
  SELECT con.conname, con.conrelid::int8 AS from_oid, con.confrelid::int8 AS to_oid,
         fn.nspname AS from_schema, fc.relname AS from_table,
         tn.nspname AS to_schema, tc.relname AS to_table,
         ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                ORDER BY k.ord) AS from_columns,
         ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                ORDER BY k.ord) AS to_columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class fc ON fc.oid = con.conrelid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
    JOIN pg_catalog.pg_class tc ON tc.oid = con.confrelid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
   WHERE con.contype = 'f'
     AND fn.nspname = ANY($1::text[])
     AND tn.nspname = ANY($1::text[])
   ORDER BY fn.nspname, fc.relname, con.conname`;

export const readSchema = async (
  pool: Pool,
  schemas: string[]
): Promise<SchemaSnapshot> => {
  const listed = userSchemas(schemas);
  if (listed.length === 0) return { tables: [], foreignKeys: [] };

  // One snapshot for all three queries, so a concurrent change cannot split them.
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const relations = await client.query<{
      oid: string;
      nspname: string;
      relname: string;
      relkind: string;
    }>(RELATIONS, [listed]);
    const columns = await client.query<{
      oid: string;
      attname: string;
      position: number;
      native_type: string;
      typname: string;
      typtype: string;
      base_typname: string | null;
      base_typtype: string | null;
      nullable: boolean;
      is_primary_key: boolean;
    }>(COLUMNS, [listed]);
    const keys = await client.query<{
      conname: string;
      from_oid: string;
      to_oid: string;
      from_schema: string;
      from_table: string;
      to_schema: string;
      to_table: string;
      from_columns: string[];
      to_columns: string[];
    }>(FOREIGN_KEYS, [listed]);
    await client.query("COMMIT");

    const byOid = new Map<string, SnapshotTable>();
    for (const row of relations.rows) {
      byOid.set(row.oid, {
        schemaName: row.nspname,
        name: row.relname,
        kind: row.relkind === "v" || row.relkind === "m" ? "view" : "table",
        columns: [],
      });
    }
    for (const row of columns.rows) {
      byOid.get(row.oid)?.columns.push({
        name: row.attname,
        type: mapPostgresType(
          row.typname,
          row.typtype,
          row.base_typname === null || row.base_typtype === null
            ? null
            : { typname: row.base_typname, typtype: row.base_typtype }
        ),
        nativeType: row.native_type,
        nullable: row.nullable,
        position: row.position,
        isPrimaryKey: row.is_primary_key,
      });
    }
    const foreignKeys: SnapshotForeignKey[] = keys.rows
      .filter((row) => byOid.has(row.from_oid) && byOid.has(row.to_oid))
      .map((row) => ({
        constraintName: row.conname,
        from: {
          schemaName: row.from_schema,
          table: row.from_table,
          columns: row.from_columns,
        },
        to: {
          schemaName: row.to_schema,
          table: row.to_table,
          columns: row.to_columns,
        },
      }));
    return { tables: [...byOid.values()], foreignKeys };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
