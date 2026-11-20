# Measures

A **measure** is the organisation's agreed definition of a number, such as `paid_revenue`, written
once per source, described in words and used by name in every query, saved query, dashboard panel
and MCP conversation. Claude sees the measures a caller may use with their descriptions and
formulas, prefers them, and asks which one is meant when two could fit (gross or net revenue).

A measure is an aggregate on **one table** (its home table): `sum(total)` over the rows where
`status = 'paid'`. Zeteo expands it into the query while planning, so the query's own filters and
grouping apply to it exactly as to an aggregate written inline, grants are checked as for any
column, and both SQL dialects, the caps and the dashboard cache work unchanged.

## Fields

| Field | Rules |
|---|---|
| `name` | `^[a-z][a-z0-9_]{0,62}$`, unique per source across its tables. The default output name when selected. |
| `description` | Required, 1 to 2,000 characters: what it is, when to use it, when not to. Data, never instructions. |
| `table` | The home table, by its query name. |
| `formula` | An expression of the query language that is group-level: every column it reads sits inside an aggregate, or comes from other measures. It may use `case`, date operations, calendar functions and `{ "measure": name }` of other measures **on the same home table**. |
| `where` | Optional filter over the home table's columns and its to-one relation paths, with literal or relative values. It applies to every aggregate in the formula, including those of measures it uses. |
| `fixed` | Optional boolean, default false. See [Fixed measures](#fixed-measures). |
| `date_column` | Optional path to a date or timestamp column on the home table or through its to-one relations (`created_at`, `customer.signup_date`). Metric queries bucket and cut the measure by it. |

The joins a measure needs are derived from the paths the formula and `where` read; each must be a
to-one relation path from the home table.

```json
{
  "name": "paid_revenue",
  "description": "Revenue of paid orders: money received. Use gross_revenue for every order.",
  "table": "orders",
  "formula": { "sum": "total" },
  "where": { "status": { "eq": "paid" } }
}
```

## Using a measure in a query

```json
{ "source": "sales-db", "from": "orders",
  "select": [{ "bucket": "month", "column": "created_at", "as": "month" },
             { "measure": "paid_revenue" },
             { "calc": { "div": [{ "measure": "paid_revenue" }, { "count": "*" }] }, "as": "paid_per_order" }],
  "groupBy": ["month"] }
```

- A select item (`{ "measure": "paid_revenue", "as": "rev" }`, named by `as`, else the measure's
  name) or an operand inside a `calc`. `having` and `orderBy` use the output name.
- `from` must be the measure's home table; otherwise (and for a measure that does not exist or that
  the caller cannot see) the answer is `not_found_or_not_accessible`, with `suggestions` listing the
  measures usable from `from`.
- Joins the measure needs and the query has not made are added as left joins after the query's own
  (a path the query joined is reused). They count toward the source's `max_joins`
  (`too_many_joins`). Being to-one, they neither drop nor repeat rows, so adding a measure never
  changes the other aggregates of the query.
- A query that joins a to-many relation cannot use a measure: `measure_needs_single_rows`. Query
  from the measure's table without that join.
- Expansion: the measure's formula replaces it, inner measures likewise, and the accumulated
  `where` is put inside each aggregate (`sum(x)` becomes `sum(case when W then x end)`, `count(*)`
  `count(case when W then 1 end)`). Nesting is at most 8 levels, the expanded expression at most 500
  operation and aggregate nodes per query. Errors inside an expanded measure are reported at the
  measure's path in the query.
- A measure whose column a catalogue refresh marked missing is `missing_in_source` where used.

## Fixed measures

A measure with `fixed: true` ignores the query it is used in: it is computed over its whole home
table (its own `where` still applies) and is one value, such as `last_actuals_month`
(`{ "max": "month" }` over a SAP table). Its formula must be group-level like any measure's.

- **Usable from any table** of the source: the home-table rule does not apply, and neither does
  `measure_needs_single_rows`, as it reads none of the query's rows. It compiles to a scalar
  subquery (`(SELECT agg FROM home LEFT JOIN ... WHERE ...)`), so it adds no join to the query and
  never changes its rows.
- Usable wherever an expression can appear: a select item, an operand of a `calc`, inside other
  measures (also inside their aggregates), and as a **comparison value** in `where`, `having` and a
  `case`'s `if`: `{ "month": { "gt": { "measure": "last_actuals_month" } } }`.
- **At group level** it is the same value on every group and row; the query's filters and `groupBy`
  do not change it, and in a metric query `bucket` and `range` do not cut it.
- A query holds at most 10 fixed-measure subqueries, and a fixed measure's own joins must fit the
  source's `max_joins`.
- Visible under the grant rule below, planned alone against the caller's catalogue.

## Date columns

`date_column` is checked when saved: it must resolve, through to-one relations, to a date or
timestamp column (refused at `date_column` otherwise). A caller who cannot read that column sees
the measure with `date_column: null` (a sources admin or an upload's owner sees it as stored), and
in a bucketed or ranged metric query it is `measure_has_no_date`. An editor who cannot read a
measure's date column and changes something else with `PATCH` keeps it as stored: it is checked
only when the change sets `date_column` or moves the measure to another table.

## Metrics

A **metric** is a named, described formula over measures of different tables of one source, such
as `roas` (`revenue` over `ad_spend`). Fields: `name` (`^[a-z][a-z0-9_]{0,62}$`, unique per source
across measures **and** metrics), `description` (1 to 2,000 characters, data, never instructions)
and `formula`: numbers, `{ "measure": name }` (fixed or not), `add`, `sub`, `mul`, `div`, `abs`,
`round`, `coalesce` and the constant calendar functions (such as `businessDaysInMonth` of a relative
date). It reads no column and has no `case`; a metric does not use another metric.

```json
{ "name": "roas", "description": "Revenue per unit of ad spend.",
  "formula": { "div": [{ "measure": "revenue" }, { "measure": "ad_spend" }] } }
```

A metric is visible to a caller only if every measure it uses is; otherwise it is absent and using
it is `not_found_or_not_accessible`. The calls are `GET` and `POST /v1/sources/{id}/metrics`,
`GET`, `PATCH` and `DELETE .../metrics/{metricId}` and `POST .../metrics/preview` (entry point
`measure_preview`), with the measures' permissions, editors and redaction (an editor sees a metric
they cannot fully see as name, description and `usable: false`, never `formula`), `used_by` and
`broken`. Audit events: `zeteo.metric.created`, `.updated`, `.deleted`.

## Metric queries

A second query shape, told apart by its `metrics` key, combines measures of different tables of one
source per period:

```json
{ "source": "sales-db", "metrics": ["revenue", "spend"], "bucket": "month",
  "range": { "gte": { "relative": { "unit": "year", "offset": 0, "startOf": true } } },
  "orderBy": [{ "period": "asc" }], "limit": 100 }
```

- `metrics`: 1–20 names, each asked for once, each a metric or a measure (a measure alone is the
  trivial metric).
- `bucket` (optional, any bucket unit, fiscal ones included) and `range` (optional, `gte`, `lt` or
  both, each `{ "date" }`, `{ "timestamp" }` or `{ "relative" }`, half-open) apply to each non-fixed
  measure's own date column (`date_column`, through its to-one relations). A measure without one, or
  whose date column the caller cannot read, is `measure_has_no_date` at its name; without `bucket`
  and `range` it is fine. A relative bound resolves in the calendar's time zone: a date column gets
  the local date, a timestamp column the instant. A date bound against a timestamp column is local
  midnight in the calendar's zone; a timestamp bound against a date column is its local date.
- Result: `period` (the bucket start, when bucketed) then one column per name, in order. `period`
  is a date when every date column is a date, else a timestamp (date buckets read as UTC
  midnight). Periods are those any measure has; a measure with no rows in a period gives null.
  Without `bucket` there is one row. Arithmetic on a missing period's null is null (a metric's
  `coalesce` gives a default); it is never 0.
- The `range` follows the calendar's time zone while `bucket` stays in UTC, as in table queries.
- Rows whose date column is null form a null `period` when bucketed, and have no place in a `range`.
- A Postgres `real` measure is read as `float8` in metric queries, so periods of different
  measures line up in one column type.
- Fixed measures read no periods: they are one value on every row, and a `bucket` over fixed
  measures only is `invalid_operator`. A non-fixed measure must be a number (`invalid_operator`).
- `orderBy` names `period` or a requested name (`invalid_order` otherwise); `limit` and `offset`
  as usual. No `where`, `join`, `groupBy` or `having`.
- At most 20 non-fixed measures in all, those a metric uses included (`too_complex`);
  fixed-measure subqueries count toward 10 as in a table query. With `bucket`, no name may be
  `period` and at least one measure must be non-fixed.
- Not in a metric query: filters on other dimensions, and metrics using metrics.
- A dashboard panel over a metric query with time column `"range"` takes the dashboard's time
  range as its `range`, replacing the stored one.
- Compiled, on both engines, as one aggregate subquery per non-fixed measure (its home table and
  joins, the range on its date column, grouped by the bucket), unioned with each measure's value in
  its own column (`v0`, `v1`…, null in the others) so each keeps its own type, then grouped by
  `period` with `max` picking each value, and fixed measures as scalar subqueries.

## Who sees what (the grant rule)

A caller sees and can use a measure only if its home table, every column it reads (through other
measures too) and every relation it joins are in the caller's visible catalogue. Otherwise it is
absent from every listing and using it is `not_found_or_not_accessible`. `GET /v1/catalog` and the
MCP `describe_table` list each table's visible measures with description, formula and filter;
`list_tables` and `list_sources` carry counts, and the per-caller MCP instructions say when a source
has measures. A measure's name and description show to every editor of the source, even one not
granted everything it reads (its formula and filter never do), so descriptions should say what it
means in plain words and leave out column names and filter values; the forms, the MCP tools and
`query_guide` say so. A source's editors can also list, preview, create, change and delete measures and
metrics through MCP tools, under the same rules as the API ([mcp.md](mcp.md#measures-over-mcp)).

## Changing measures

Two layers:

1. The role permission `zeteo.measures.write` ("Manage measures"), on `zeteo_admin` and `zeteo_user`.
   It does nothing until the holder is an editor of a source.
2. A per-source **editor list** of users and groups: `GET` and `PUT
   /v1/sources/{id}/measure-editors` (whole replace, audited). Database sources: managed by
   `zeteo.sources.write` holders. Upload sources: also by the owner (`zeteo.uploads.write` with
   `zeteo.data.read`), who is always an editor of their own source while they hold
   `zeteo.measures.write`. A transfer keeps the list; the new owner becomes an editor.

A draft is planned against the **editor's** visible catalogue, so an editor cannot define a measure
over columns they are not granted. Holders of `zeteo.sources.read` and the owner of an upload source
see every measure in full, with `broken` set when it no longer plans. An editor who is neither sees a
measure they cannot fully see redacted (name, table, description, `usable: false`, never `formula` or
`where`) and cannot change or delete it.

On every save the measure and every measure using it, transitively, are re-checked against the
source's whole catalogue (home table, result type, loops, nesting, node limits, missing columns). If
a dependent (a measure or a metric) would break, the save is refused with `409 measure_in_use` and
`dependents: [{ "kind": "measure" | "metric", "name": ... }]`; renaming or deleting a measure other
measures or metrics use is refused the same way. Saved queries and panels
do not block a change: `used_by` (`saved_queries`, `panels`) shows how many use a measure so an
editor knows before changing it. Once a measure they use is renamed or deleted, those saved queries
fail with `saved_query_not_accessible`, like any saved query the caller cannot run, and their panels
show a state other than `ok`; a direct query naming it fails with `not_found_or_not_accessible`.

Removing an upload table deletes the measures on it and, directly, the metrics that use any of
them; deleting the source deletes all its measures and metrics.

An upload source's owner retyping, renaming or re-uploading a table, or a column, is not checked
against the measures that read it: a measure it breaks is kept and shows `broken` (and stops being
usable) until an editor fixes it.

## The API

| Call | Permission | Returns |
|---|---|---|
| `GET /v1/sources/{id}/measures` | `zeteo.data.read`, `zeteo.sources.read` or `zeteo.measures.write` | the measures the caller sees: visible ones in full, others (for editors and admins) flagged `usable: false`, with `used_by` and `broken` where the caller may see them; `can_edit` and `can_manage_editors`, whether the caller may change the measures and the editor list (both false once the source is archived) |
| `POST /v1/sources/{id}/measures` | `zeteo.measures.write`, an editor | the created measure |
| `GET`, `PATCH`, `DELETE /v1/sources/{id}/measures/{measureId}` | read as above; changes `zeteo.measures.write`, an editor | the measure; `409 measure_in_use` when a dependent would break |
| `POST /v1/sources/{id}/measures/preview` | `zeteo.measures.write`, an editor | runs an unsaved draft grouped by nothing or by an optional bucket, as a normal query (limits, run log with entry point `measure_preview`) |
| `GET`, `POST /v1/sources/{id}/metrics`; `GET`, `PATCH`, `DELETE .../metrics/{metricId}`; `POST .../metrics/preview` | as measures | see [Metrics](#metrics) |
| `GET`, `PUT /v1/sources/{id}/measure-editors` | read as above; `PUT` as described above | the editors, users and groups |

Audit events: `zeteo.measure.created`, `.updated`, `.deleted`, `zeteo.measure_editors.updated`. The
SDK has `zeteo.measures` (`list`, `create`, `get`, `update`, `delete`, `preview`, `editors`,
`replaceEditors`) and `zeteo.metrics` (`list`, `create`, `get`, `update`, `delete`, `preview`).

## In the admin UI

A source's page has a **Measures** tab: the list (name, table, description, used-by counts, broken
flag) and the editor list for those who may change it. Creating or editing a measure is a page of
its own, with the details (name, table, description, a **Fixed** toggle and a **Date column** select
of the table's date and timestamp columns and its to-one relations'; changing the table clears it)
on the left and JSON editors for `formula` and `where` on the right, validated live against the
server (plan errors with their paths shown inline), and **Preview**. A **Metrics** tab lists metrics
with the measures they use; creating or editing one is a page with a JSON formula and Preview (a month-bucketed metric query over the last 12 months). A refused delete
shows the server's message and what depends on it.
My Zeteo shows measures with their descriptions under what a person can query.

## Gauge chart

A dashboard panel can be a `gauge`: `{ "type": "gauge", "version": 1, "value": col, "max": col,
"target"?: col, "min"?: col | number, "unit"? }`, the columns being result columns (typically measure
outputs) read from the first row. It is drawn as an arc: the value fills it, the target is a marker
and `max` the end of the scale. A null value or `max` shows "No data"; a null target has no marker. See [dashboards.md](dashboards.md).

## Not supported

- Filters on non-date dimensions in metric queries, and metrics using other metrics.
- Elapsed and remaining business days over columns: `businessDaysInMonth` takes a column, the other
  calendar functions a date or relative date only ([calendar.md](calendar.md)).
- Using a non-fixed measure from a query whose `from` is not its home table, row-level reusable
  calculations, and a text formula syntax: they are written as JSON.
