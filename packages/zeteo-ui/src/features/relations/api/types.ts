// Field for field the OpenAPI `Relation` and `DeclareRelationRequest` schemas.

export interface Relation {
  id: string;
  name: string;
  from_table_id: string;
  from_columns: string[];
  to_table_id: string;
  to_columns: string[];
  to_many: boolean;
  origin: "discovered" | "declared";
  missing_since: string | null;
}

export interface DeclareRelation {
  name: string;
  from_table_id: string;
  from_columns: string[];
  to_table_id: string;
  to_columns: string[];
  to_many: boolean;
}
