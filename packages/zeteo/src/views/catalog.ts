import type {
  Relation,
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";

const iso = (date: Date | null) => date?.toISOString() ?? null;

export const tableView = (row: SourceTable) => ({
  id: row.id,
  source_id: row.sourceId,
  schema_name: row.schemaName,
  name: row.name,
  kind: row.kind,
  description: row.description,
  last_seen_at: row.lastSeenAt.toISOString(),
  missing_since: iso(row.missingSince),
});

export const columnView = (row: SourceColumn) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  native_type: row.nativeType,
  nullable: row.nullable,
  position: row.position,
  is_primary_key: row.isPrimaryKey,
  description: row.description,
  missing_since: iso(row.missingSince),
});

export const relationView = (row: Relation) => ({
  id: row.id,
  name: row.name,
  from_table_id: row.fromTableId,
  from_columns: row.fromColumns,
  to_table_id: row.toTableId,
  to_columns: row.toColumns,
  to_many: row.toMany,
  origin: row.origin,
  missing_since: iso(row.missingSince),
});

/** A table with its columns and the relations that start at it. */
export const tableDetailView = (
  table: SourceTable,
  columns: SourceColumn[],
  relations: Relation[]
) => ({
  ...tableView(table),
  columns: columns.map(columnView),
  relations: relations.map(relationView),
});
