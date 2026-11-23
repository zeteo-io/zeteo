---
"@zeteo-io/sdk": minor
---

Row rules. `Grant` gains `row_access`, `row_rule`, `row_rule_description` and `row_rule_problems`; `CreateGrantRequest` takes `row_access` (default `unlimited_default`) with a `row_rule` for `rule`, and **`ReplaceGrantRequest` requires `row_access`**. New types `RowAccess`, `RowRule`, `RowRuleOperators`, `RowFields` and `IdentityRef`. New calls: `identityKeys` (`list`, `create`, `update`, `delete`, `missing`, and `values.list`, `values.add`, `values.delete`) and `grants.effective({ user_id, table_id, organization_id? })` for one user's combined access to one table, with their types (`IdentityKey`, `IdentityKeyName`, `IdentityValue`, `MissingIdentityValues`, `EffectiveAccess`). `QueryResult` gains `rows_limited`, a dashboard `PanelLine` with a `result` may carry it, and a catalogue `DiscoveredTable` has `rows_limited` and `rows_limited_reason`.
