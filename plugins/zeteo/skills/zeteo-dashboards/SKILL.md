---
name: zeteo-dashboards
description: Use when building or changing zeteo dashboards, panels or saved panels, choosing charts, or checking a chart with preview_panel.
---

# Zeteo dashboards

A dashboard is a set of panels; each panel shows a saved query as a chart, run by each viewer with their own access.

1. To show the user a chart, write its query, choose a chart that fits the result's shape and call `preview_panel` with `query` and a chart: nothing is saved. In clients that show MCP Apps the user sees it as a card under that call, as after each dashboard change. Do not draw it again or say it cannot be shown, and keep checking the tool's own result: fix the chart until `problems` is empty.
2. Save only when the user wants to keep the chart: `create_saved_query` (or start from a saved query that is available for dashboards, `list_saved_queries`), then `create_dashboard` and `add_panel`, or keep a reusable chart as a saved panel (`create_saved_panel`) and link it.
3. `preview_panel` also takes `saved_query_id` to check a chart over a saved query; `get_saved_panel` and `get_dashboard` show saved charts as cards.
4. Change only the user's own dashboards and panels.

Read [reference.md](reference.md) when a chart needs more than the basics or after an error you cannot fix: the chart settings, time ranges, layout and rules.
