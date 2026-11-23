import type { ComparedValue, FilterOperators, FilterValue } from "./query.js";
import type { ListOptions, PrincipalType } from "./common.js";

export type PrincipalStatus = "active" | "orphaned" | "unknown";

/**
 * `unlimited_default` adds the grant's columns and never widens rows when
 * another grant limits them; `all` is every row, overriding other grants'
 * limits; `rule` limits rows to those matching the grant's `row_rule`.
 */
export type RowAccess = "unlimited_default" | "all" | "rule";

/**
 * The caller's own values under an identity key; with `below`, also those of
 * everyone who reports to them (not available yet: Zeteo does not read Tereo's
 * reporting lines yet, so it is refused).
 */
export interface IdentityRef {
  identity: string;
  below?: boolean;
}

export interface RowRuleOperators extends Omit<
  FilterOperators,
  "eq" | "ne" | "in" | "notIn" | "between" | "gt" | "gte" | "lt" | "lte"
> {
  eq?: Exclude<ComparedValue, { measure: string }> | IdentityRef;
  ne?: Exclude<ComparedValue, { measure: string }> | IdentityRef;
  gt?: Exclude<ComparedValue, { measure: string }>;
  gte?: Exclude<ComparedValue, { measure: string }>;
  lt?: Exclude<ComparedValue, { measure: string }>;
  lte?: Exclude<ComparedValue, { measure: string }>;
  between?: FilterOperators["between"];
  in?: FilterValue[] | IdentityRef;
  notIn?: FilterValue[] | IdentityRef;
}

/**
 * A filter over the grant's own table in the query language's `where` syntax:
 * keys are that table's column names (granted or not), no relation paths. An
 * identity condition that resolves to no values makes the whole rule match no
 * rows.
 */
export type RowRule =
  | { and: RowRule[] }
  | { or: RowRule[] }
  | { not: RowRule }
  | { [column: string]: RowRuleOperators };

/** The rows a grant reaches, as sent. `row_rule` goes with `rule` only. */
export type RowFields =
  | {
      row_access: "unlimited_default" | "all";
    }
  | {
      row_access: "rule";
      row_rule: RowRule;
      /** Up to 200 characters, shown to callers in place of the generated sentence. */
      row_rule_description?: string;
    };

export interface Grant {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_status: PrincipalStatus;
  source: { id: string; slug: string };
  table: { id: string; schema_name: string; name: string; missing: boolean };
  all_columns: boolean;
  columns: { id: string; name: string; missing: boolean }[];
  /** The owner's grant on an upload source's table; it cannot be removed or narrowed. */
  owner_grant: boolean;
  row_access: RowAccess;
  /** By column names and identity key names; null unless `row_access` is `rule`. */
  row_rule: RowRule | null;
  row_rule_description: string | null;
  /** What keeps the rule from applying: `column_missing:<name>`, `column_unknown:<id>`, `identity_key_unknown:<id>`. */
  row_rule_problems: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** On create, `row_access` defaults to `unlimited_default`. */
export type CreateGrantRequest = (
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
    }
) &
  (RowFields | { row_access?: undefined });

/**
 * Replaces the columns and rows whole. `row_access` is required: a body of
 * columns only is refused (400), so it cannot drop a rule by accident.
 */
export type ReplaceGrantRequest = (
  { all_columns: true } | { all_columns: false; column_ids: string[] }
) &
  RowFields;

export interface IdentityKey {
  id: string;
  /** The slug a rule names; never changes. */
  name: string;
  /** What callers read in place of the name. */
  label: string;
  description: string | null;
  /** Values held under the key, all users together. */
  value_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** What `list` returns to a caller holding only `zeteo.uploads.write`. */
export interface IdentityKeyName {
  name: string;
  label: string;
  description: string | null;
}

export interface CreateIdentityKeyRequest {
  /** A lowercase letter, then up to 63 of a-z, 0-9 and _. */
  name: string;
  /** 1 to 100 characters. */
  label: string;
  /** Up to 500 characters. */
  description?: string;
}

/** Label, description or both; `null` clears the description. */
export interface UpdateIdentityKeyRequest {
  label?: string;
  description?: string | null;
}

export interface IdentityValue {
  id: string;
  key_id: string;
  user_id: string;
  /** Exact text: nothing is trimmed or case-folded. */
  value: string;
  created_by: string;
  created_at: string;
}

export interface ListIdentityValuesOptions extends ListOptions {
  user_id?: string;
}

export interface NewIdentityValue {
  user_id: string;
  /** 1 to 500 characters. */
  value: string;
}

/** Users a grant whose rule uses the key reaches who hold no value under it. */
export interface MissingIdentityValues {
  users: { user_id: string; via_grant_ids: string[] }[];
}

export interface EffectiveAccessOptions {
  user_id: string;
  table_id: string;
  /** Counts this organization's groups too; absent, global groups only. */
  organization_id?: string;
}

export type EffectiveAccessWarning =
  | { code: "all_rows_overrides"; grant_id: string }
  | { code: "missing_identity_value"; key: string }
  | { code: "row_rule_unavailable"; reason: string }
  | { code: "merged_members_limited"; member_table_ids: string[] };

/** What one user gets of one table over all the grants that reach them. */
export interface EffectiveAccess {
  /** `"all"`, or the granted columns' names. */
  columns: "all" | string[];
  rows: "all" | "limited" | "none";
  /** The combined rule in words, naming every column; null when rows are not limited. */
  rule_summary: string | null;
  grants: {
    grant_id: string;
    principal_type: PrincipalType;
    principal_id: string;
    row_access: RowAccess;
  }[];
  warnings: EffectiveAccessWarning[];
}

export interface ListGrantsOptions extends ListOptions {
  principal_type?: PrincipalType;
  principal_id?: string;
  table_id?: string;
  source_id?: string;
}
