import type { ListOptions, PrincipalType } from "./common.js";

export type PrincipalStatus = "active" | "orphaned" | "unknown";

export interface Grant {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_status: PrincipalStatus;
  source: { id: string; slug: string };
  table: { id: string; schema_name: string; name: string; missing: boolean };
  all_columns: boolean;
  columns: { id: string; name: string; missing: boolean }[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type CreateGrantRequest =
  | {
      principal_type: PrincipalType;
      principal_id: string;
      table_id: string;
      all_columns: true;
    }
  | {
      principal_type: PrincipalType;
      principal_id: string;
      table_id: string;
      all_columns: false;
      /** 1 to 500 distinct columns of the table. */
      column_ids: string[];
    };

export type ReplaceGrantRequest =
  { all_columns: true } | { all_columns: false; column_ids: string[] };

export interface ListGrantsOptions extends ListOptions {
  principal_type?: PrincipalType;
  principal_id?: string;
  table_id?: string;
  source_id?: string;
}
