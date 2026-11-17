// Field for field the OpenAPI `Grant`, `CreateGrantRequest` and
// `ReplaceGrantRequest` schemas.

import type { PrincipalStatus, PrincipalType } from "@/features/principals";

export interface GrantColumn {
  id: string;
  name: string;
  missing: boolean;
}

export interface Grant {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_status: PrincipalStatus;
  source: { id: string; slug: string };
  table: { id: string; schema_name: string; name: string; missing: boolean };
  all_columns: boolean;
  /** Empty when `all_columns` is true. */
  columns: GrantColumn[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type ReplaceGrant =
  { all_columns: true } | { all_columns: false; column_ids: string[] };

export type CreateGrant = ReplaceGrant & {
  principal_type: PrincipalType;
  principal_id: string;
  table_id: string;
};

export interface GrantFilters {
  source_id?: string;
  table_id?: string;
  principal_type?: PrincipalType;
  principal_id?: string;
}

export const MAX_GRANT_COLUMNS = 500;
