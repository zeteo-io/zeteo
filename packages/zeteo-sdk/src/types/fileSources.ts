export type FileColumnType =
  "text" | "number" | "boolean" | "date" | "timestamp";

export interface StagedColumn {
  /** The column's 0-based position in the file. */
  index: number;
  name: string;
  original_name: string;
  type: FileColumnType;
  /** Up to 10 values seen, as text. */
  samples: string[];
}

export interface StagedTable {
  /** Names the table within the staging: `csv`, `sheet:<name>` or `table:<name>`. */
  key: string;
  name: string;
  kind: "csv" | "sheet" | "table";
  /** The 0-based header row; null when the first row looks like data. */
  header_row: number | null;
  /** Data rows, the header not counted. */
  row_count: number;
  columns: StagedColumn[];
  warnings: string[];
}

export interface UploadResponse {
  staging_id: string;
  /** One hour after the upload. */
  expires_at: string;
  tables: StagedTable[];
}

export interface ColumnCorrection {
  index: number;
  /** Lowercase letters, digits and `_`, starting with a letter; at most 63 bytes. */
  name?: string;
  type?: FileColumnType;
}

export interface TableCorrection {
  /** A staged table's `key`. */
  key: string;
  name?: string;
  header_row?: number | null;
  columns?: ColumnCorrection[];
}

export interface CreateFileSourceRequest {
  staging_id: string;
  name: string;
  /** Generated from the name when omitted. */
  slug?: string;
  /** 1 to 100 staged tables, with any corrections. */
  tables: TableCorrection[];
}

export interface AddTablesRequest {
  staging_id: string;
  tables: TableCorrection[];
}

export interface ReuploadTableRequest {
  staging_id: string;
  key: string;
  header_row?: number | null;
  columns?: ColumnCorrection[];
}

export interface UpdateFileColumnRequest {
  /** At least one field. */
  type?: FileColumnType;
  name?: string;
  description?: string | null;
}

export interface TransferFileSourceRequest {
  user_id: string;
  /** The previous owner keeps an ordinary all-columns grant; the API's default is true. */
  keep_access?: boolean;
}

export interface FileSourceColumn {
  id: string;
  name: string;
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
  /** How many people and groups its tables are shared with, the owner grants not counted. */
  share_count: number;
  tables: FileSourceTable[];
}

export interface ListFileSourcesOptions {
  /** `mine` (the default) or `all`, which needs `zeteo.sources.read`. */
  scope?: "mine" | "all";
}
