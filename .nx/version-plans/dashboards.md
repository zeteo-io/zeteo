---
zeteo: minor
"@zeteo-io/sdk": minor
---

Dashboards: a dashboard is a grid of panels, each a saved query shown as a chart, a stat or a table, with saved panels to reuse a chart on many dashboards. Dashboards and saved panels are shared with users and groups, copied and transferred; a saved query's owner switches "Available for dashboards" on for others' panels. Every viewer runs every panel with their own grants, over a time range built from relative dates in the query language, as a stream of one line per panel with a short Redis cache (`DASHBOARD_CACHE_TTL_SECONDS`) and a recording window (`DASHBOARD_RECORD_WINDOW_MINUTES`) that records a dashboard's runs once per viewer per query. `/v1/dashboards`, `/v1/saved-panels`, `GET /v1/saved-queries?scope=available`, `GET /v1/saved-queries/{id}/dashboards`, the permissions `zeteo.dashboards.read` and `.write`, MCP tools for dashboards and saved panels, Dashboards, a display mode for wall screens and admin pages in the UI. SDK: `dashboards` and `savedPanels` calls.
