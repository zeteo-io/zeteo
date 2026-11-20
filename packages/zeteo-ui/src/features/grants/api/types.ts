// Field for field the OpenAPI `Grant`, `CreateGrantRequest` and
// `ReplaceGrantRequest` schemas.

import type { PrincipalStatus, PrincipalType } from "@/features/principals";

export interface GrantColumn {
  id: string;
  name: string;
  missing: boolean;
}

export type RowAccess = "unlimited_default" | "all" | "rule";

/** A row rule as the API takes and gives it: a filter keyed by column name. */
export type RowRule = unknown;

export interface Grant {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_status: PrincipalStatus;
  source: { id: string; slug: string };
  table: { id: string; schema_name: string; name: string; missing: boolean };
  all_columns: boolean;
  /** An upload source owner's own grant: it cannot be removed or narrowed (only moved by a transfer). */
  owner_grant?: boolean;
  /** Empty when `all_columns` is true. */
  columns: GrantColumn[];
  row_access: RowAccess;
  /** Present when `row_access` is "rule", with column names. */
  row_rule?: RowRule;
  row_rule_description?: string | null;
  /** What no longer holds of the rule (a column the table lost, an identity key removed). */
  row_rule_problems: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type ReplaceColumns =
  { all_columns: true } | { all_columns: false; column_ids: string[] };

/** What a grant limits of a table's rows; a replace sends both columns and rows. */
export type ReplaceRows =
  | { row_access: "unlimited_default" | "all" }
  | {
      row_access: "rule";
      row_rule: RowRule;
      row_rule_description?: string;
    };

export type ReplaceGrant = ReplaceColumns & ReplaceRows;

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
