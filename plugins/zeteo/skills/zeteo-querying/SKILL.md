---
name: zeteo-querying
description: Use when answering questions from the organization's databases through zeteo, writing or fixing a zeteo query, or using saved queries.
---

# Querying with zeteo

Zeteo answers questions from databases the user has been granted access to, through the `zeteo` MCP server. Only granted tables and columns exist for the user.

1. `list_sources`, then `list_tables` for a source, then `describe_table` for the columns and relations. Use only names these tools return; never guess.
2. Write the query as one JSON object (no raw SQL) and run it with `query`.
3. If a query is refused, read the error, fix the query and run it again.
4. To keep or rerun a query, use the saved query tools (`list_saved_queries`, `run_saved_query`, `create_saved_query`).
5. Only when the user asks, and only as one of the source's measure editors: create or change measures and metrics (`list_measures`, `preview_measure`, `create_measure`, `update_measure`; the same for metrics). Everyone who queries the source shares them.

Read [reference.md](reference.md) when a query needs more than the basics (calculations, relative dates, grouping rules) or after an error you cannot fix: the full query language, results, limits, errors and saved queries.
