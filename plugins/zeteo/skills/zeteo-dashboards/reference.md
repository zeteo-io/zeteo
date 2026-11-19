<!-- Written by npm run plugin:reference in packages/zeteo; edit src/mcp/reference.ts. -->

# Building dashboards with Zeteo

## Dashboards
A dashboard is panels, each a saved query shown as a chart. To show the user a chart, write its query and call `preview_panel` with `query` and `chart`: nothing is saved. It returns the result's `columns`, the first rows and `problems`; fix the chart until `problems` is empty. `preview_panel` also takes `saved_query_id` instead of `query`, for a saved query. Save only when the user wants to keep the chart: `create_saved_query`, then `create_dashboard` (or an existing one), one `add_panel` per panel, then give the user the dashboard's `url`; or `create_saved_panel` to keep a chart to reuse (`link_saved_panel`, `detach_panel`). `list_dashboards` and `get_dashboard` read dashboards; `update_panel`, `remove_panel` and `update_dashboard` change your own. `get_saved_panel` and `get_dashboard` also show a saved chart. In clients that show MCP Apps, the user sees zeteo's own chart as a card under that call, and under each change of a saved panel or dashboard: do not draw it again or say it cannot be shown. The card is for the user, so still read the tool's result yourself.
- Chart settings: `{"type","version":1,...}`; every column is a result column of the query (a select item's `as`, else its path). `stat`: `value` (number), `compare`: `"next_row"` (needs `orderBy`), `unit`. `line`, `area`: `x` (date, timestamp or number), `y` (list of numbers), `series`. `bar`: `x`, `y`, `series`, `horizontal`. `pie`: `label`, `value`. `gauge`: `value` (the progress), `max` (the end of the scale), optional `target` (a marker) and `min` (a column or a number), `unit`; all read from the first row, so give the query one row, such as measures selected without `groupBy`. For budget pacing: value the spend so far, target the pace, max the budget. `table`: `columns` (optional). `area` and `bar` also take `stacked`.
- `time_column` makes the panel follow the dashboard's `time_range` (such as `last_30_days`): a date or timestamp column path reachable from the query's `from` table (`created_at`, `orders.created_at`), never a bucket's `as` name.
- A panel over a metric query (one with `metrics`) follows the time range with `time_column: "range"`: the range replaces the query's own `range`, each measure cut on its date column. A metric query takes no other `time_column`, and a table query never takes `"range"`.
- `x`, `y`, `w`, `h` may be left out: the panel goes in the first free place. A panel with a `state` other than `ok` is not yours to run; do not guess its chart.
- Sharing a dashboard is done in Zeteo's UI.
```json
{"dashboard_id":"<id from create_dashboard>","saved_query_id":"<id from create_saved_query>","chart":{"type":"bar","version":1,"x":"customers.region","y":["revenue"]},"time_column":"created_at","title":"Revenue by region"}
```

