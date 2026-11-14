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
}

export interface TableDetail extends Table {
  columns: Column[];
  relations: Relation[];
}

export interface PatchTable {
  description?: string | null;
  columns?: { name: string; description: string | null }[];
}
