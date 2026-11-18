// Field for field zeteo's staging preview (`POST /v1/uploads`) and the bodies
// of an upload source's routes under `/v1/sources`.

export type FileColumnType =
  "text" | "number" | "boolean" | "date" | "timestamp";

export const FILE_COLUMN_TYPES: FileColumnType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
];

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

export interface CreateUploadSource {
  type: "upload";
  staging_id: string;
  name: string;
  description?: string;
  slug?: string;
  tables: TableCorrection[];
}

export interface UpdateColumn {
  type?: FileColumnType;
  name?: string;
  description?: string | null;
}
