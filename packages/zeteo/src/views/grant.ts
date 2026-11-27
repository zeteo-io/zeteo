import { ruleProblems, toApiRule, type RuleNames } from "../row-rules/store.js";
import type { PrincipalStatus } from "../grants/principals.js";
import type { GrantDetail } from "../utils/db/grants.js";
import type { RuleFilter } from "../row-rules/types.js";

/** `names`: the names of the columns and identity keys the row's rule uses (`ruleNamesFor`). */
export const grantView = (
  row: GrantDetail,
  principalStatus: PrincipalStatus,
  names: RuleNames
) => ({
  id: row.id,
  principal_type: row.principalType,
  principal_id: row.principalId,
  principal_status: principalStatus,
  source: { id: row.table.source.id, slug: row.table.source.slug },
  table: {
    id: row.table.id,
    schema_name: row.table.schemaName,
    name: row.table.name,
    missing: row.table.missingSince !== null,
  },
  all_columns: row.allColumns,
  /** The upload source owner's own grant: not removed or narrowed while set. */
  owner_grant: row.ownerGrant,
  columns: row.columns.map(({ column }) => ({
    id: column.id,
    name: column.name,
    missing: column.missingSince !== null,
  })),
  /** `unlimited_default`, `all` or `rule`. */
  row_access: row.rowAccess,
  /** The rule by column and identity key names; null unless `rule`. */
  row_rule:
    row.rowRule === null
      ? null
      : toApiRule(row.rowRule as RuleFilter, names.columns, names.keys),
  row_rule_description: row.rowRuleDescription,
  /** What keeps the rule from applying, for an admin: `column_missing:<name>` and the like. */
  row_rule_problems:
    row.rowRule === null
      ? []
      : ruleProblems(row.rowRule as RuleFilter, names.columns, names.keys),
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

export type GrantView = ReturnType<typeof grantView>;
