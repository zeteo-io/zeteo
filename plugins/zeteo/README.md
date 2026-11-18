# zeteo plugin for Claude Code

Gives Claude the zeteo MCP server and two skills: `zeteo-querying` (the query
language and saved queries) and `zeteo-dashboards` (dashboards, panels, charts).
The skills' descriptions are always in Claude's context, so it knows what zeteo
is for before calling a tool.

## Install

```
/plugin marketplace add <this repo>
/plugin install zeteo@zeteo
```

Claude Code asks for the **Zeteo MCP URL** at install: `https://<your zeteo>/mcp`
(change it later with
`echo '{"mcp_url":"https://<your zeteo>/mcp"}' | claude plugin configure zeteo --values-stdin`). Zeteo's MCP endpoint must
be on (`MCP_ALLOWED_CLIENTS`), and you sign in through tereo when the server
first connects.

## The reference files

`skills/*/reference.md` are generated from `packages/zeteo/src/mcp/reference.ts`;
do not edit them. After changing that module, run `npm run plugin:reference` in
`packages/zeteo`. A unit test fails when they drift.
