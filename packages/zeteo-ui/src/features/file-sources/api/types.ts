// Field for field zeteo's `fileSourceView` (src/views/fileSource.ts) and the
// staging preview (src/file-sources/staging.ts).

export type FileColumnType =
  "text" | "number" | "boolean" | "date" | "timestamp";

export const FILE_COLUMN_TYPES: FileColumnType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
];

export interface FileSourceColumn {
  id: string;
  name: string;
  /** The header text it came from. */
  original_name: string | null;
  type: FileColumnType;
  description: string | null;
  missing: boolean;
}

export interface FileSourceTable {
  id: string;
  name: string;
  description: string | null;
  row_count: number;
  last_synced_at: string | null;
  missing: boolean;
  columns: FileSourceColumn[];
}

export interface FileSource {
  id: string;
  slug: string;
  name: string;
  type: "upload";
  owner_id: string;
  created_at: string;
  archived_at: string | null;
  stored_bytes: number;
  /** People and groups its tables are shared with, the owner's own grants not counted. */
  share_count: number;
  tables: FileSourceTable[];
}

export interface PreviewColumn {
  index: number;
  name: string;
  original_name: string;
  type: FileColumnType;
  samples: string[];
}

export interface PreviewTable {
  /** `csv`, `sheet:<name>` or `table:<name>`. */
  key: string;
  name: string;
  kind: "csv" | "sheet" | "table";
  /** 0-based; null when the file has no header. */
  header_row: number | null;
  row_count: number;
  columns: PreviewColumn[];
  warnings: string[];
}

export interface Staging {
  staging_id: string;
  expires_at: string;
  tables: PreviewTable[];
}

export interface ColumnCorrection {
  index: number;
  name?: string;
  type?: FileColumnType;
}

export interface TableCorrection {
  key: string;
  name?: string;
  header_row?: number | null;
  columns?: ColumnCorrection[];
}

export interface CreateFileSource {
  staging_id: string;
  name: string;
  slug?: string;
  tables: TableCorrection[];
}

export interface UpdateColumn {
  type?: FileColumnType;
  name?: string;
  description?: string | null;
}
