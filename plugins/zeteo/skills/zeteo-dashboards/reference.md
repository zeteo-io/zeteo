<!-- Written by npm run plugin:reference in packages/zeteo; edit src/mcp/reference.ts. -->

# Building dashboards with Zeteo

## Dashboards
A dashboard is panels, each a saved query shown as a chart. To build one: find or create the saved queries (`create_saved_query`), check each chart with `preview_panel` (it returns the result's `columns`, the first rows and `problems`; fix the chart until `problems` is empty), `create_dashboard`, one `add_panel` per panel, then give the user the dashboard's `url`. `list_dashboards` and `get_dashboard` read them; `update_panel`, `remove_panel` and `update_dashboard` change your own. `create_saved_panel` saves a chart to reuse (`link_saved_panel`, `detach_panel`). Clients that show MCP Apps draw a preview card after `preview_panel` and after each dashboard change; the card is for the user, so still read the tool's result yourself.
- Chart settings: `{"type","version":1,...}`; every column is a result column of the saved query (a select item's `as`, else its path). `stat`: `value` (number), `compare`: `"next_row"` (needs `orderBy`), `unit`. `line`, `area`: `x` (date, timestamp or number), `y` (list of numbers), `series`. `bar`: `x`, `y`, `series`, `horizontal`. `pie`: `label`, `value`. `table`: `columns` (optional). `area` and `bar` also take `stacked`.
- `time_column` makes the panel follow the dashboard's `time_range` (such as `last_30_days`): a date or timestamp column path reachable from the query's `from` table (`created_at`, `orders.created_at`), never a bucket's `as` name.
- `x`, `y`, `w`, `h` may be left out: the panel goes in the first free place. A panel with a `state` other than `ok` is not yours to run; do not guess its chart.
- Sharing a dashboard is done in Zeteo's UI.
```json
{"dashboard_id":"<id from create_dashboard>","saved_query_id":"<id from create_saved_query>","chart":{"type":"bar","version":1,"x":"customers.region","y":["revenue"]},"time_column":"created_at","title":"Revenue by region"}
```

