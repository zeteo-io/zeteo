import { originOf } from "../uploads/origin.js";
import { tableSyncError } from "./source.js";
import type {
  Relation,
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";

/** A table's origin as views give it: a merged table's as its member count. */
const originView = (row: SourceTable) => {
  const origin = originOf(row);
  return origin?.kind === "merged"
    ? { kind: "merged" as const, members: origin.definition.members.length }
    : origin;
};

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
  /**
   * An upload source's table: the rows loaded. A database source's: the
   * database's estimate at the last refresh, null when it gave none.
   */
  row_count: row.rowCount === null ? null : Number(row.rowCount),
  /** An upload source's table: when it was last loaded; null for a database source's. */
  last_loaded_at: iso(row.lastSyncedAt),
  /**
   * An upload source's table: where it comes from (a file, a Sheets tab, a
   * merge, given as its number of members); null for a database source's.
   */
  origin: originView(row),
  /**
   * A Google Sheets table's last failed sync; null when its last sync was good
   * or it has none. These views are its owner's and `zeteo.sources.read`'s only.
   */
  sync_error: tableSyncError(row.lastSyncError),
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
  /** An upload source's column: the file's header text; null for a database source's. */
  original_name: row.originalName,
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
