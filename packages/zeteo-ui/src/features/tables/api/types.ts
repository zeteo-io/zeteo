// Field for field the OpenAPI `Table`, `Column`, `TableDetail` and
// `PatchTableRequest` schemas.
import type { Relation } from "@/features/relations/api/types";

export interface Table {
  id: string;
  source_id: string;
  schema_name: string;
  name: string;
  kind: "table" | "view";
  description: string | null;
  last_seen_at: string;
  missing_since: string | null;
  /** An upload's rows loaded; null for a database source. */
  row_count: number | null;
  /** When an upload's table was last loaded; null for a database source. */
  last_loaded_at: string | null;
  /** Where an upload's table came from; a merged table says how many members. */
  origin?: { kind: "file" | "google-sheets" | "merged" } | null;
}

export interface Column {
  id: string;
  name: string;
  type: string;
  native_type: string;
  nullable: boolean;
  position: number;
  is_primary_key: boolean;
  description: string | null;
  missing_since: string | null;
  /** An upload's column: the header text in the file; null for a database source. */
  original_name: string | null;
}

/** A merged table's definition and state, on the detail of a merged table only. */
export interface MergedDetail {
  label_column: string;
  members: {
    table_id: string;
    name: string;
    label: string;
    missing: boolean;
  }[];
  columns: {
    id: string;
    name: string;
    /** The member column name it maps from. */
    from_name: string;
    type: string;
    members: string[];
    missing: boolean;
  }[];
  /** Columns the members have that the merged table does not carry. */
  available: { name: string; type: string; members: string[] }[];
  /** A member whose column cannot fill the merged column (it gives NULL). */
  warnings: { column_id: string; table_id: string }[];
}

export interface TableDetail extends Table {
  columns: Column[];
  relations: Relation[];
  /** Present when the table is merged. */
  merged?: MergedDetail | null;
}

export interface PatchTable {
  description?: string | null;
  columns?: { name: string; description: string | null }[];
}
