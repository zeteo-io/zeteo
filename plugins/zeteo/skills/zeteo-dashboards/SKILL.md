---
name: zeteo-dashboards
description: Use when building or changing zeteo dashboards, panels or saved panels, choosing charts, or checking a chart with preview_panel.
---

# Zeteo dashboards

A dashboard is a set of panels; each panel shows a saved query as a chart, run by each viewer with their own access.

1. Start from a saved query that is available for dashboards (`list_saved_queries`), or create one.
2. Choose a chart that fits the result's shape and check it with `preview_panel` before adding it.
3. Build with `create_dashboard` and `add_panel`, or keep a reusable chart as a saved panel (`create_saved_panel`) and link it.
4. To show the user a chart, call `preview_panel`, `get_saved_panel` or `get_dashboard`: in clients that show MCP Apps the user sees it as a card under that call, as after each dashboard change. Do not draw it again or say it cannot be shown, and keep checking the tool's own result.
5. Change only the user's own dashboards and panels.

Read [reference.md](reference.md) when a chart needs more than the basics or after an error you cannot fix: the chart settings, time ranges, layout and rules.
