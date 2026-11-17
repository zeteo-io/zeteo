# Dashboards

A dashboard is a grid of panels. Each panel shows a [saved query](saved-queries.md) as a chart, a
stat or a table. A dashboard holds no data and no permission of its own: everyone who opens one
runs every panel as themselves, against their own and their groups' grants
([grants.md](grants.md)), so sharing a dashboard never widens anyone's access to data. The
reference is `openapi/openapi.yaml`; the SDK has the same calls under `zeteo.dashboards` and
`zeteo.savedPanels`.

## Concepts

- **Dashboard**: a name, a description, an owner, a default time range, an auto-refresh interval
  (`refresh_seconds`), a theme (`light`, `dark`, `auto`) and up to 50 panels on a 12-column grid.
  Names are unique per owner whatever the case.
- **Panel**: a position and size (`x`, `y`, `w`, `h`), an optional title and one of two kinds.
  An **own** panel holds a saved query and its chart settings (and, optionally, a time column). A
  **linked** panel points at a saved panel and shows whatever that saved panel shows.
- **Saved panel**: a saved query with chart settings under a name, owned by one user, that many
  dashboards can link. Changing it changes every dashboard that links it. **Save as saved panel**
  turns an own panel into one (`POST /v1/dashboards/{id}/panels/{panelId}/save`) and
  `.../detach` turns a linked panel back into an own one.
- Dashboards and saved panels are shared with users and groups, copied and transferred as saved
  queries are ([saved-queries.md](saved-queries.md)), and every change is audited
  (`zeteo.dashboard.*`, `zeteo.saved_panel.*`; the metadata carries names and ids, never queries).

## Which saved queries a dashboard may use: the reach rule

A panel may use a saved query when its owner owns the saved query, or when the saved query's
**Available for dashboards** toggle is on and the viewer is signed in to the organization it was
made available in. The toggle is set by the saved query's owner (`available_for_dashboards` on
`PATCH /v1/saved-queries/{id}`); turning it on records the organization the owner was signed in
to, turning it off clears it. A null organization matches only a null organization. For a linked
panel the rule applies to the saved panel's owner as well as the dashboard's. The rule says what
an owner has chosen to publish; whether a viewer can actually run the query is still decided by
their grants.

`GET /v1/saved-queries?scope=available` lists what the caller may put on a dashboard.
`GET /v1/saved-queries/{id}/dashboards` (permission `zeteo.dashboards.read`) lists the dashboards
and saved panels built on a saved query, by name and owner, and a saved query's view carries
`used_by: { dashboards, saved_panels }` counts for those who may manage it.

## Panel states and their copy

Every read and run of a dashboard decides each panel for the viewer, in this order: a deleted
saved query or saved panel; a saved panel neither the dashboard's owner's nor shared with them;
the reach rule; the saved query planned as the viewer; the chart against the planned columns. A
panel that is not `ok` carries a `state` and a `message`, and none of its chart, query or source.

| State | Message | When |
|-------|---------|------|
| `ok` | none | the viewer can run it |
| `not_accessible` | the saved query's own "You need expanded permissions to run this saved query. Ask an admin to extend your access." | the viewer's grants do not cover it, or the owner's saved query is not reachable for the viewer's organization; no cause is told apart |
| `saved_query_deleted` | "This panel's saved query was deleted." | |
| `saved_panel_deleted` | "This panel's saved panel was deleted." | |
| `not_available` | "This saved query is no longer available for dashboards." | the toggle was turned off |
| `needs_update` | "This panel needs updating by its owner." | the chart no longer fits the query's columns |

A saved panel no longer shared with the dashboard's owner reads "This saved panel is no longer
shared with this dashboard's owner." The owner of the dashboard is told more of their own
settings (a `problems` list naming the chart setting at fault) than a viewer is.

## Chart format

A chart is our own JSON, version 1; every field naming a column names a result column (a select
item's `as`, else its path). `decimals` (0 to 6) and `legend` (`auto`, `none`) are optional on all.

| `type` | Fields | Column types |
|--------|--------|--------------|
| `stat` | `value`, `compare: "next_row"`, `unit` | `value` number; `compare` needs an `orderBy` |
| `line` | `x`, `y` (1 to 10), `series` | `x` date, timestamp or number; `y` number; `series` text |
| `area` | as `line`, and `stacked` | as `line` |
| `bar` | `x`, `y`, `series`, `stacked`, `horizontal` | `y` number; `series` text |
| `pie` | `label`, `value`, `donut` | `label` text; `value` number |
| `table` | `columns` (all when absent) | any |

A chart is checked against the columns of the plan, so nothing runs to check it. The problems
are `missing_column`, `wrong_type` and `needs_order`, each with the setting at fault (`y.0`).
New panels take a default size by type (stat 3 by 2, table 12 by 4, the others 6 by 4) and the
first free cell on the grid.

## Time range

A dashboard has a default time range and a viewer may pick another for the run. An own panel with a
`time_column` has it filtered: the range is ANDed onto the saved query's `where` as
`<column> >= start` and `<column> < end`. A panel without one is not filtered. The ranges are
`last_15_minutes`, `last_hour`, `last_6_hours`, `last_24_hours`, `last_7_days`, `last_30_days`,
`last_90_days`, `last_6_months`, `last_year`, `last_2_years`, `today`, `this_week`, `this_month`,
`this_quarter`, `this_year`, `previous_week`, `previous_month`, `previous_quarter` and
`previous_year`. They are built from relative dates ([querying.md](querying.md#relative-dates)),
in UTC and against one `now`, floored to the minute, for all of a run's panels. A week starts on
Monday.

## Running a dashboard

`POST /v1/dashboards/{id}/run` (permission `zeteo.data.read`) takes `{ panels?, time_range? }`
(a subset of panel ids; a range, or `null` for none) and answers a stream of JSON lines. Each
line is one panel, sent as soon as it is ready:

```json
{ "panel_id": "...", "state": "ok", "result": { "columns": [...], "rows": [...], "truncated": false }, "cached_at": "2026-11-17T10:00:00.000Z" }
{ "panel_id": "...", "state": "not_accessible", "message": "..." }
{ "panel_id": "...", "state": "ok", "error": { "error": "source_unreachable", "error_description": "..." } }
{ "done": true }
```

A panel that is not `ok` is sent at once and never run. `cached_at` is present when the result came
from the cache. `result.notice` says so when rows were left out at the row cap (a dashboard's
profile is 1,000 rows by default, at most 5,000 or 2 MB). The last line is `{ "done": true }`.
A panel whose run failed is `ok` with an `error`, and the other panels carry on. A refusal found
while running is the same `not_accessible` line.

Panels whose runs are the same (saved query, time column and range) run once and every one of
them gets its line. At most the lower of the viewer's query concurrency and
`DASHBOARD_PARALLELISM` run at a time. A run is the `dashboard` entry point of the engine
([querying.md](querying.md#the-run-log)).

### Lease waiting

A dashboard run waits for a slot where a query would be refused: while the viewer's own limit (their
other tabs or screens) or the source's concurrency limit refuses a lease (`too_many_queries`,
`source_busy`), it retries, after 100 ms and then twice as long each time up to 2 seconds, until
the run's deadline (the source's query timeout); then that refusal is the panel's error. Any other failure is immediate.

## The cache

This is the first time zeteo keeps query results anywhere. A dashboard run's result is kept in
Redis for `DASHBOARD_CACHE_TTL_SECONDS` (default 60), under the key
`zeteo:dash:result:<fingerprint>`, for the dashboard entry point only: the API, MCP and exports
never read or write it. A result whose JSON exceeds the dashboard profile's byte limit is not
kept. When Redis fails, that is a miss. Identical runs in one process also share one execution.

The fingerprint is a hash of the source, the plan and the row cap. **Sharing an entry between
viewers is safe** because the planner builds a plan only from the viewer's visible catalogue
(granted tables and columns, relations whose keys are all granted) and the query's bound values,
so equal plans compile to the same SQL and parameters over data both viewers may read. A viewer
without a grant never reaches the entry, because they never get that plan. **A future row filter
must be part of the plan**, or this stops being true; there is no row filter yet.

## The recording window

The run log ([querying.md](querying.md#the-run-log)) records a dashboard run at most once per
viewer per query per `DASHBOARD_RECORD_WINDOW_MINUTES` (default 60), however often the dashboard
refreshes: the first run of a query (by fingerprint) opens a fixed window, which later runs do not
extend, and only that run is recorded and stamps the saved query's `last_run_at`. Failures have
their own window so a failure never hides a success, and a refused panel is recorded the same way
with its query withheld. Every other path (API, MCP, export) records every run. A run that cannot
be recorded closes its window again and the rows are withheld, as for any query.

## Display mode

`/dashboards/<id>/display` in the admin UI shows one dashboard alone, without the top bar, in the
dashboard's theme, refreshing itself every `refresh_seconds` (never faster than
`DASHBOARD_MIN_REFRESH_SECONDS`) and keeping a panel's last result with "Stale since" when a run
fails. It does not redirect to Tereo on a lost session: it shows "Signed out - sign in again on
this screen" and a **Sign in** button, so an unattended wall screen never loops through sign-in.

**A dedicated display user.** A screen shows what its user may see, so give it a user of its own:
create a user in Tereo with the role `zeteo_user`, grant it only the tables the dashboards need
(a group works well), share the dashboards with it (or with its group), sign in once on the screen
at the display address and leave it. Do not sign a wall screen in as a person.

**How long a screen stays signed in** depends on Tereo's refresh-token and session configuration,
which this repository does not set and which was not measured here: the page renews its access
token with Tereo's httpOnly refresh cookie ([admin-ui.md](admin-ui.md#where-the-session-lives)),
and when the session ends the screen shows the signed-out notice until someone signs in again.
Check the lifetime in the Tereo deploy that serves the screen and plan the sign-in interval from
it.

## Permissions

| Permission | Grants |
|------------|--------|
| `zeteo.data.read` | an ordinary user's own dashboards and saved panels and those shared with them; every route above |
| `zeteo.dashboards.read` | lists and reads every dashboard and saved panel and their shares (`scope=all`), and the uses of a saved query |
| `zeteo.dashboards.write` | includes read; also shares, transfers and deletes any dashboard or saved panel |

Neither is organization-assignable, and both are in `zeteo_admin`. Changing a dashboard's panels,
name or settings is the owner's alone. Reading a dashboard as an admin runs its panels as the admin,
by their own grants. Anyone who may not see a dashboard gets `404 not_found`.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `DASHBOARD_CACHE_TTL_SECONDS` | 60 | How long a dashboard run's result is kept in Redis (5 to 3600) |
| `DASHBOARD_RECORD_WINDOW_MINUTES` | 60 | The recording window per viewer and query (1 to 1440) |
| `DASHBOARD_MIN_REFRESH_SECONDS` | 60 | The shortest `refresh_seconds` a dashboard may have (10 to 86400) |
| `DASHBOARD_PARALLELISM` | 4 | Most panel queries one dashboard run executes at a time (1 to 20) |

## MCP

The tools of [mcp.md](mcp.md#the-tools) list, read, create, change and delete the caller's own
dashboards and saved panels, add, change, remove, link and detach panels, and `preview_panel`
runs a saved query and checks a chart against its result before a panel is added.
