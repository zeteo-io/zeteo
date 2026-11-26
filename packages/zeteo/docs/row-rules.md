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

### Organization-scoped groups

Only the grants **active for the sign-in** count, and a group that belongs to an organization is
active only when the user's token is for that organization (global groups and the user's own
grants always are). This holds for a group's rule as for its columns, so the formula above is over
the grants of that sign-in, and two consequences follow:

1. A grant that **doesn't limit rows** (`unlimited_default`) on a global group or on the user gives
   **every row** whenever the user signs in outside the organization whose group carries the rule:
   to another organization, or to none. The organization's rule then reaches no one.
2. A user who belongs to **no active organization** (created by an admin and never added to one, or
   whose organizations are all inactive) gets a token without an organization, so **every
   organization-scoped group's rule drops out** for them. (A user with at least one active
   organization always gets one in their token. Service accounts get no group grants at all.)

To limit someone everywhere, put the rule on a grant to the user or to a global group. Effective
access warns `org_scoped_rule_inactive` when a rule on one of the user's organization groups does
not apply under the sign-in it is asked about.

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
  - `{ "identity": "<key>", "below": true }`: the values of the caller and of everyone below
    them in Tereo's reporting lines, at any depth (a manager's reports, their reports, and so on).
    See [Everyone below the caller](#everyone-below-the-caller).

`eq` with an identity means "is one of my values" (as `in`); `ne` and `notIn` mean "is none of
them".

A rule follows SQL's rules for NULL: `ne`, `notIn` and `not` **also hide rows whose column is
NULL**, as no comparison with a NULL holds (it fails closed). To keep those rows, say so:

```json
{ "or": [ { "channel": { "notIn": ["Retail"] } }, { "channel": { "isNull": true } } ] }
```

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
their types, literals parse to the column's type, and identity keys exist. A JSON number that is not
the double it parses to, digit for digit (`9007199254740993`, which parses to 2^53, or
`0.10000000000000001`, which parses to `0.1`), is refused, as is one the parsed double writes with
an exponent (`1e21`, `1e-7`): write such numbers as decimal strings (`"9007199254740993"`). A number
written with more digits than it needs but the same value (`1.50`) is kept. A bound of `gt`, `gte`, `lt`, `lte` or
`between` on a number column with more than 38 digits (before the point, leading zeros aside, and
after it) is refused: SQL Server holds no decimal that long and would compare it through a float. A
rule that is not valid is
`400 invalid_row_rule`, with `path` into the request body starting `row_rule`.

**Upload source owners** may write rules on their own tables' grants, but **without identity
values**: a rule an owner writes (as the owner, without `zeteo.grants.write`) that names
`{ "identity": … }` anywhere is `400 invalid_row_rule`, with `path` to the reference. Otherwise an
owner could put a rule on a group they belong to and read, through their own table, which values
they and their reports hold. Admins with `zeteo.grants.write` may use identity values on any grant,
an upload source's included. The grant dialog offers an owner no "is one of my …" conditions.

## Identity keys and values

An **identity key** is a named key (`netsuite_employee_id`, `display_name`, `google_id`) under
which users hold **identity values**: the way a source names a person (an employee id in one table,
a display name in a sheet). A user may hold several values under a key; a value belongs to one user
within its key (`409 identity_value_taken`, with the `value`), compared as exact text. Only users
hold values, never groups. Deactivated users keep theirs.

**Matching uses the source database's own comparison**, not Zeteo's: a value is bound as it is
(never trimmed or case-folded by Zeteo) and the source compares it with the column. SQL Server's
usual collations ignore case and trailing spaces, so `rep-ab`, `REP-AB` and `rep-ab   ` match the
same rows; a `citext` or `char` column in Postgres is similar; and against a number column values
compare as numbers, so `"8"` and `"08.0"` match the same rows. Values that differ as text can
therefore still match the same rows: give two people values that differ in more than case,
padding or number formatting. Adding values warns `near_duplicate` when a new value equals another
user's that way.

| Route | Permission | Result |
|-------|------------|--------|
| `GET /v1/identity-keys` | `zeteo.grants.read`, or `zeteo.uploads.write` | every key; the second gets only `name`, `label`, `description` |
| `POST /v1/identity-keys` | `zeteo.grants.write` | `201`, the key (`{ name, label, description? }`; `name` is a lowercase slug and never changes) |
| `PATCH /v1/identity-keys/:keyId` | `zeteo.grants.write` | the key, with a new `label` or `description` |
| `DELETE /v1/identity-keys/:keyId` | `zeteo.grants.write` | `204`; `409 identity_key_in_use` (with `grant_ids`) while a rule names it |
| `GET /v1/identity-keys/:keyId/values` (`user_id`, `limit`, `cursor`) | `zeteo.grants.read` | `{ data, next_cursor }` |
| `POST /v1/identity-keys/:keyId/values` | `zeteo.grants.write` | `201`, `{ data, warnings }`; body `{ values: [{ user_id, value }] }`, 1 to 1,000 pairs, all or none; `warnings` lists `{ code: "near_duplicate", value, user_id }` for each new value equal to another user's after trimming and ignoring case, or as a number (`user_id` is the other user) |
| `DELETE /v1/identity-keys/:keyId/values/:valueId` | `zeteo.grants.write` | `204` |
| `GET /v1/identity-keys/:keyId/missing` | `zeteo.grants.read` | `{ users: [{ user_id, via_grant_ids }] }`: users a rule using the key reaches who hold no value |

A key has an `id`, `name`, `label` (what callers read: "your NetSuite employee ID"), `description`,
`value_count` and timestamps. Identity values are access configuration, so no new permission exists.
Upload source owners (`zeteo.uploads.write`) may read key names and labels, never any value, and
may not use identity values in the rules they write. Every change is audited (`zeteo.identity_key.created`,
`.updated`, `.removed`; `zeteo.identity_value.added`, `.removed`) in the same transaction.

## Everyone below the caller

`{ "identity": "<key>", "below": true }` stands for the values under `<key>` of the caller and of
every user below them in Tereo's reporting lines (`PUT /v1/admin/users/:id/reports-to` in Tereo),
transitively. A director whose rule is `{ "sales_rep": { "in": { "identity": "rep_id", "below":
true } } }` sees their own orders and those of every rep under their managers.

- Zeteo asks Tereo (`listUserReports`, transitive; its `user_resolver` role carries `users.read`)
  only when a rule reaching the caller uses `below`, and never inside a transaction. The answer is
  cached in-process for 30 seconds per user, so a reorganisation applies within that.
- Deactivated users stay in the chain and keep their values: a deactivated manager does not cut
  their reports off from the director above, and a deactivated rep's old rows stay visible.
- A user with no reports gets exactly their own values; with none of their own and nobody below
  holding one, the grant's rule matches no rows.
- The 50,000-value cap counts the values of everyone below.
- A service account has no place in the reporting lines: `below` gives it only its own values,
  and Tereo is not asked.
- The caller's own sentence (`rows_limited_reason`) names no one below them.

## Failing closed

Any input that cannot be resolved yields fewer rows or a refused query, never more.

| Situation | Outcome |
|---|---|
| The caller has no value under a key a rule names | **That grant's whole rule matches no rows**, whatever operator or `not` surrounds the identity condition. Other grants still apply. |
| A rule's column has gone missing from the catalogue | Queries reading the table are refused with `409 row_rule_unavailable` ("ask an admin"); the grant shows `column_missing:<name>` in `row_rule_problems`. |
| A rule resolves to more than 50,000 values | Refused with `409 row_rule_unavailable`; never truncated. |
| An identity key is deleted while rules use it | The delete is refused: `409 identity_key_in_use`. |
| Tereo cannot say who reports to the caller (unreachable, erroring, or no such user) while a rule uses `below` | Queries reading the table are refused with `503 row_rule_unavailable` ("try again shortly"); never the caller's own rows only, never every row. |
| Tereo refuses the reporting lines as too large (over 10,000 users or 64 levels) | Refused with `409 row_rule_unavailable`, reason `too_many_values`. |
| Tereo is unreachable while a grant's groups are read | The request fails as it does today; there is no fallback to wider access. |

An identity value that does not convert to the rule column's type is dropped; with none left the
condition is empty, which matches no rows.

On SQL Server a number the rule column's type (as the catalogue last read it) cannot hold, an
identity value past `int` on an `int` column say, is left out of an `eq` or `in`, which only drops
rows. In a `ne` or `notIn`, or an `eq` or `in` under a `not`, it is compared exactly, as
`decimal(38, s)`, so a column widened since the last refresh still hides the rows holding it. A
value of more than 38 digits, which no SQL Server exact number holds, makes such a condition keep
no row ([azure-sql.md](azure-sql.md)).

## Enforcement

At plan time, for each table in the caller's visible catalogue, the rows of every grant reaching
them are combined by the formula and resolved. The planner then reads **every reference** to a
table with a rule (the base table and every join target, inner or left, to-one or to-many, a fixed
measure's table and a metric part's) through the rule, so a hidden row never appears: on a left join the parent row stays with the related
columns null, on an inner join it drops. Values are bound parameters; large sets are one array
parameter on Postgres (`= ANY($1)`) and one JSON value read with `OPENJSON` on SQL Server. A
measure aggregates over its home table through the rule, and a fixed measure ignores the query's
filters but never row rules. The resolved rule is part of the plan, so the dashboard cache and
shared execution key on it: two viewers share an entry only when their resolved rules are identical.

No calculation or condition the caller writes is ever evaluated on a row their rule hides. An
error raised there (an overflow, a date pushed out of range) would fail the request because of a
row the caller cannot see, and that one bit, asked often enough, reads the row. Neither engine keeps
a subquery's condition ahead of the conditions around it, so a ruled table is read through a step
of its own:

- **Postgres** reads it as `(with r as materialized (select <columns> from <table> where <rule>)
  select * from r)`. The documentation says `MATERIALIZED` forces separate calculation of the `WITH`
  query (PostgreSQL 12 and later), so the caller's conditions apply to its output only. A
  rule-limited query on an older server is refused (`409 row_rule_unavailable`).
  (`security_barrier`, Postgres's own mechanism for this, is an option of a view; user queries run
  in a read-only transaction, which may create nothing.)
- **SQL Server** copies the rule's rows by a statement of their own, `select <columns> into #rN from
  <table> where <rule>`, run before the query in the same request; the query reads `#rN` and never
  the table. SQL Server may evaluate any expression of a statement before another of its conditions,
  even through a `CASE`; only the order of statements is kept. Any user may create temp tables, a
  read-only login and a read-only replica included, and the request's temp tables are dropped when
  it ends. References to one table under the same rule and conditions (a fixed measure's table and
  the query's, the parts of a metric) share one copy.

The read keeps only the columns the query reads of the table (join keys, measures and metric parts
included; none for `count(*)` alone). Beside the rule it also applies the caller's conditions that
cannot raise an error on any row, so an index can serve them: a whole conjunct of the query's
`where` (never inside `or` or `not`, never `having`, a calculation, a measure, a fixed measure's
value or a business-day check) on a column of the from table or of an inner-joined table (never a
left-joined one, whose missing rows the condition decides), and a metric part's range on its own
table's date column. The condition must be `isNull`, a comparison, `between` or an `in` of at most
100 values against values bound as exactly the column's own type, so nothing is converted per row:

| | Postgres | SQL Server |
|---|---|---|
| numbers | an integer in an integer column's range (`smallint`, `integer`, `bigint`, `real`, `double precision`); any number for `numeric` | an integer in the column's range (`tinyint`, `smallint`, `int`, `bigint`); a decimal the `decimal`/`numeric` column holds exactly |
| text | `text`, `varchar`, `char`, `uuid` | `nvarchar` (any length); `startsWith` and `contains` too |
| dates and times | `date`, `timestamp`, `timestamptz` | `date`; `datetime2`, `datetimeoffset` and `datetime` within years 1754–9998 and offsets up to ±14:00, with no finer fraction than the column keeps |
| booleans | `boolean` | `bit` |

Anything else stays outside the read: on SQL Server `varchar`, `char`, `nchar`, `uniqueidentifier`,
`float`, `real`, `money` and `smalldatetime` columns, on Postgres every `startsWith`/`contains`
(`ILIKE` raises on a column with a nondeterministic collation) and enum, money and domain columns,
and on both engines any value that is not exactly the column's type. The same rows match either
way.

The cost: what the caller's conditions cannot narrow, the read reads in full, so such a query costs
about as much as reading all the caller's rows of the table; on SQL Server the read is copied to
`tempdb` once per query.

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
  "no rows right now; ask an admin" means their rule cannot be applied (`row_rule_unavailable`), and
  "no rows right now; try again shortly" that it uses `below` and Tereo cannot give the reporting
  lines now (the `503`). A rule with `below` reads "… is your <key label> or that of anyone who
  reports to you", naming no one.
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
`row_rule_unavailable` (with a `reason`: `column_missing`, `too_many_values`, or
`hierarchy_unavailable` when Tereo cannot give the user's reporting lines) and `merged_members_limited` (a merged table the user
reads rows of, whose members' rows are limited differently: by a rule while the merged table shows
every row, or by a rule other than the merged table's, compared by column name; the
`member_table_ids` are those members) and `org_scoped_rule_inactive` (a rule on one of the
user's groups of another organization than `organization_id`, or of any organization when none is
given: under that sign-in it limits nothing; with `group_id`, `group_name`, `organization_id` and
`organization_name`). Groups scoped to an organization count only when `organization_id` is theirs,
as for a token ([Organization-scoped groups](#organization-scoped-groups)); `organizations` lists the
organizations of the user's groups, which the admin UI's Effective access dialog offers to ask
again with. It is never cached.

## Audit and transfer

A grant's rule is part of the existing `zeteo.grant.created` and `zeteo.grant.updated` entries
(`row_access`, `row_rule` in its stored form, by column and key ids, and `row_rule_description` in the metadata). Transferring an upload source
gives the new owner an `unlimited_default` owner grant; a previous grant of theirs that carried
rows is reset and its id listed in the transfer entry's `row_access_reset`.

## Not yet

- Rules that propagate across relations, named reusable policies, database-native row-level
  security, and fuzzy matching of identity values.
