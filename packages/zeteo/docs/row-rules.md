# Row rules

A grant says which tables and columns someone may query. A **row rule** on a grant says which
**rows**. Without one a grant reaches every row of its table, as it always has. The reference for
the routes is `openapi/openapi.yaml`; grants themselves are in [grants.md](grants.md).

A rule is enforced on every way of reading data: `POST /v1/query`, `POST /v1/export`, MCP `query`,
saved queries (run as the caller), dashboard panels, measures and metrics. A rule limits the rows
of **its own table only**; it does not follow relations ("customers reachable from my orders") yet.

## What a grant says about rows

Every grant has `row_access`:

| `row_access` | Meaning |
|---|---|
| `unlimited_default` (the default on create) | Adds its columns. Never widens rows when another grant limits them. |
| `all` | Explicitly all rows: overrides every limit from the caller's other grants. |
| `rule` | Only rows matching the grant's `row_rule`; `row_rule_description` is optional. |

`row_rule` goes with `rule` and with nothing else (`400 invalid_request` otherwise). On a create,
`row_access` may be left out. **A `PUT` must send `row_access`** (no default), so a body of columns
only is a `400` and cannot silently drop a rule. An upload source owner's own grant is always
`unlimited_default`; setting rows on it is `409 owner_grant_locked`. The grant's view adds
`row_access`, `row_rule` (by column and identity key names, null unless `rule`),
`row_rule_description` and `row_rule_problems` (see "Failing closed").

## What a caller gets: the formula

Per caller, per table, over every grant that reaches them (their own and their groups'), independent
of grant order and of user against group grants:

```
if no grants reach the caller:     the table does not exist for them (as today)
columns = union of every grant's columns
rows =
  if any grant is `all`:           all rows
  elif any grant is `rule`:        OR of those grants' resolved rules
  else:                            all rows (as today)
read the table as: SELECT <columns> FROM table WHERE <rows>   -- everywhere it appears
```

So a limit beats no limit, and an explicit `all` beats a limit. Example: "everyone: `order_id`,
`channel`, doesn't limit rows" with "reps: all columns, own rows": a rep sees their own orders with
every column. Someone in "Retail" and "West Reps" sees both sets of rows. A director in "Reps" and in
"Sales leadership" (`all`) sees every row. There is no per-row column masking: one rule per table.
Whoever wants AND writes it inside one rule.

Each rule is resolved before the OR: identity values are looked up, relative dates are computed
against the query's "now" (a dashboard's run `now`), and an identity condition that resolves to no
values makes **that grant's whole rule false**. What changes over time: group membership (cached up
to 30 s), identity values, the clock.

## The rule

A rule is a filter in the query language's `where` syntax ([querying.md](querying.md)), restricted
to the grant's own table and extended with identity values:

- Keys are **column names of the grant's table**: no relation paths, no select names. A rule may
  filter on a column the grant does not include (the caller just cannot select or filter by it).
  Storage keeps column ids, so a rename does not break a rule.
- Every operator of the filter language (`eq`, `ne`, `in`, `notIn`, `between`, `isNull`,
  `contains`, `startsWith`, comparisons, `isBusinessDay`), literal or relative-date values, and
  nested `and` / `or` / `not` within the usual depth limit. Not `{ "measure": ... }` values.
- Two value forms, only under `eq`, `in`, `ne` and `notIn`:
  - `{ "identity": "<key>" }`: the caller's values under that identity key.
  - `{ "identity": "<key>", "below": true }`: also the values of everyone who reports to the
    caller. **Not available yet in Zeteo:** Tereo keeps reporting lines (since 0.8.3), but Zeteo
    does not read them yet, so a rule using `below` is refused (`400 invalid_row_rule`). Do not
    rely on it.

`eq` with an identity means "is one of my values" (as `in`); `ne` and `notIn` mean "is none of
them".

```json
{ "channel": { "in": ["Retail", "Wholesale"] } }
{ "channel": { "notIn": ["Retail"] } }
{ "sale_date": { "gte": { "relative": { "unit": "day", "offset": -90 } } } }
{ "and": [
  { "sales_rep": { "in": { "identity": "netsuite_employee_id" } } },
  { "sale_date": { "gte": { "relative": { "unit": "day", "offset": -90 } } } }
] }
```

On save the rule is checked: the columns exist on the table and are not missing, the operators suit
their types, literals parse to the column's type, and identity keys exist. A rule that is not valid
is `400 invalid_row_rule`, with `path` into the request body starting `row_rule`.

## Identity keys and values

An **identity key** is a named key (`netsuite_employee_id`, `display_name`, `google_id`) under
which users hold **identity values**: the way a source names a person (an employee id in one table,
a display name in a sheet). A user may hold several values under a key; a value belongs to one user
within its key (`409 identity_value_taken`, with the `value`). Matching is exact: nothing is
trimmed or case-folded, so fix mismatches in the value. Only users hold values, never groups.
Deactivated users keep theirs.

| Route | Permission | Result |
|-------|------------|--------|
| `GET /v1/identity-keys` | `zeteo.grants.read`, or `zeteo.uploads.write` | every key; the second gets only `name`, `label`, `description` |
| `POST /v1/identity-keys` | `zeteo.grants.write` | `201`, the key (`{ name, label, description? }`; `name` is a lowercase slug and never changes) |
| `PATCH /v1/identity-keys/:keyId` | `zeteo.grants.write` | the key, with a new `label` or `description` |
| `DELETE /v1/identity-keys/:keyId` | `zeteo.grants.write` | `204`; `409 identity_key_in_use` (with `grant_ids`) while a rule names it |
| `GET /v1/identity-keys/:keyId/values` (`user_id`, `limit`, `cursor`) | `zeteo.grants.read` | `{ data, next_cursor }` |
| `POST /v1/identity-keys/:keyId/values` | `zeteo.grants.write` | `201`, `{ data }`; body `{ values: [{ user_id, value }] }`, 1 to 1,000 pairs, all or none |
| `DELETE /v1/identity-keys/:keyId/values/:valueId` | `zeteo.grants.write` | `204` |
| `GET /v1/identity-keys/:keyId/missing` | `zeteo.grants.read` | `{ users: [{ user_id, via_grant_ids }] }`: users a rule using the key reaches who hold no value |

A key has an `id`, `name`, `label` (what callers read: "your NetSuite employee ID"), `description`,
`value_count` and timestamps. Identity values are access configuration, so no new permission exists.
Upload source owners (`zeteo.uploads.write`) may read key names and labels to build rules on their
own tables' grants, never any value. Every change is audited (`zeteo.identity_key.created`,
`.updated`, `.removed`; `zeteo.identity_value.added`, `.removed`) in the same transaction.

## Failing closed

Any input that cannot be resolved yields fewer rows or a refused query, never more.

| Situation | Outcome |
|---|---|
| The caller has no value under a key a rule names | **That grant's whole rule matches no rows**, whatever operator or `not` surrounds the identity condition. Other grants still apply. |
| A rule's column has gone missing from the catalogue | Queries reading the table are refused with `409 row_rule_unavailable` ("ask an admin"); the grant shows `column_missing:<name>` in `row_rule_problems`. |
| A rule resolves to more than 50,000 values | Refused with `409 row_rule_unavailable`; never truncated. |
| An identity key is deleted while rules use it | The delete is refused: `409 identity_key_in_use`. |
| Tereo is unreachable while a grant's groups are read | The request fails as it does today; there is no fallback to wider access. |

An identity value that does not convert to the rule column's type is dropped; with none left the
condition is empty, which matches no rows.

## Enforcement

At plan time, for each table in the caller's visible catalogue, the rows of every grant reaching
them are combined by the formula and resolved. The planner then reads **every reference** to a
table with a rule (the base table and every join target, inner or left, to-one or to-many) as a
filtered subquery, so a hidden row never appears: on a left join the parent row stays with the related
columns null, on an inner join it drops. Values are bound parameters; large sets are one array
parameter on Postgres (`= ANY($1)`) and one JSON value read with `OPENJSON` on SQL Server. A
measure aggregates over its home table through the rule, and a fixed measure ignores the query's
filters but never row rules. The resolved rule is part of the plan, so the dashboard cache and
shared execution key on it: two viewers share an entry only when their resolved rules are identical.

A merged table is its own table: its grants carry their own rules, and a member table's rules do
not flow into it ([uploads.md](uploads.md)). Effective access warns when they differ.

## What callers see

- `rows_limited: true` on a result when any table it read had a rule: `POST /v1/query`, a saved
  query's run, a saved panel's preview, a dashboard panel line, and MCP `query`, `run_saved_query`,
  `preview_panel` and `card_panel_rows`. An export carries the header `X-Zeteo-Rows-Limited: true`.
- A table in `GET /v1/catalog`, and MCP `list_tables` and `describe_table`, has `rows_limited` and,
  when true, `rows_limited_reason`: a plain sentence from the caller's own rule ("Your own orders
  (sales rep) from the last 90 days"). It names identity keys by label, never values, and a column
  only if the caller is granted it (a condition on another column reads "some rows only"). A grant's
  `row_rule_description` replaces the generated sentence. "No rows" means no rule of theirs keeps any;
  "no rows right now; ask an admin" means their rule cannot be applied (`row_rule_unavailable`).
- MCP per-caller instructions add one line: some tables show only some rows, `describe_table` says
  which, and totals should be called "your" figures.
- Callers never see other principals' rules, the list of identity keys, or their identity values.
  Saved queries and dashboards run for a recipient with the recipient's own rules; `accessible` is
  unaffected by rules. A dashboard panel line whose rule cannot be applied carries
  `row_rule_unavailable`.

## Effective access

`GET /v1/grants/effective?user_id=&table_id=[&organization_id=]` (`zeteo.grants.read`) answers for
an admin what one user gets of one table: `columns` (`"all"` or names), `rows` (`all`, `limited` or
`none`), `rule_summary` (the combined rule in words, naming every column), the `grants` it comes
from, and `warnings`: `all_rows_overrides` (an `all` grant overriding another's rule, with its
`grant_id`), `missing_identity_value` (the `key` the user holds no value for),
`row_rule_unavailable` (with a `reason`) and `merged_members_limited` (a merged table the user
reads rows of, whose members' rows are limited differently: by a rule while the merged table shows
every row, or by a rule other than the merged table's, compared by column name; the
`member_table_ids` are those members). Groups scoped to an organization count only when `organization_id` is
given. It is never cached.

## Audit and transfer

A grant's rule is part of the existing `zeteo.grant.created` and `zeteo.grant.updated` entries
(`row_access`, `row_rule` in its stored form, by column and key ids, and `row_rule_description` in the metadata). Transferring an upload source
gives the new owner an `unlimited_default` owner grant; a previous grant of theirs that carried
rows is reset and its id listed in the transfer entry's `row_access_reset`.

## Not yet

- `below` (people who report to me, transitively): Zeteo does not read Tereo's reporting lines
  yet; until it does, a rule using it is refused.
- Rules that propagate across relations, named reusable policies, database-native row-level
  security, and fuzzy matching of identity values.
