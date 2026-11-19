import { originOf } from "../uploads/origin.js";
import { tableSyncError } from "./source.js";
import type {
  Relation,
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";

/**
 * A table's origin as views give it, in the API's snake_case: a Sheets table's
 * as its spreadsheet and tab, a merged table's as its member count.
 */
export const originView = (row: { origin: unknown }) => {
  const origin = originOf(row);
  if (origin?.kind === "merged") {
    return {
      kind: "merged" as const,
      members: origin.definition.members.length,
    };
  }
  if (origin?.kind === "google-sheets") {
    return {
      kind: "google-sheets" as const,
      spreadsheet_id: origin.spreadsheetId,
      spreadsheet_title: origin.spreadsheetTitle,
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(origin.spreadsheetId)}/edit#gid=${origin.sheetId}`,
      tab_id: origin.sheetId,
      /** Absent only for a table added before tab titles were kept. */
      ...(origin.tabTitle !== undefined && { tab_title: origin.tabTitle }),
    };
  }
  if (origin?.kind === "file") {
    return {
      kind: "file" as const,
      filename: origin.filename,
      /** An xlsx's worksheet or named table; absent for a CSV and for a table made before it was kept. */
      ...(origin.sheet !== undefined && { tab_title: origin.sheet }),
    };
  }
  return origin;
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
