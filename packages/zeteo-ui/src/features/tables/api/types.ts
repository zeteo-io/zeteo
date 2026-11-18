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

export interface TableDetail extends Table {
  columns: Column[];
  relations: Relation[];
}

export interface PatchTable {
  description?: string | null;
  columns?: { name: string; description: string | null }[];
}
