# MCP

Zeteo serves an MCP endpoint at `/mcp` so an AI client (Claude, ChatGPT, or any MCP client that
signs in with OAuth) can discover and query what a person is granted, as that person. It is built
on `@tereo-io/mcp`, from npm, which handles sign-in through Tereo, the per-user rate limit and the
protocol; zeteo defines the tools. The endpoint is not part of the OpenAPI spec.

## Turning it on

MCP is off unless `MCP_ALLOWED_CLIENTS` is set; with it empty `/mcp` is not served and the start
log says so.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MCP_ALLOWED_CLIENTS` | empty (off) | Comma-separated OAuth client ids of the login clients created in Tereo for MCP clients. Tokens issued to any other client are refused at `/mcp` |
| `MCP_ALLOWED_ORIGINS` | empty | Browser origins (`https://app.example.com`) allowed to call `/mcp` |
| `MCP_RATE_LIMIT_PER_MINUTE` | 120 | Tool calls one user may make per minute, across every replica |
| `PUBLIC_URL` | `http://localhost:4201` outside production | Zeteo's public origin. The endpoint is `${PUBLIC_URL}/mcp`, and the metadata clients read names it |
| `TEREO_URL` | | Where zeteo fetches Tereo's authorization-server metadata at start |

- **Host.** `/mcp` and its discovery documents (`/.well-known/oauth-protected-resource/mcp`,
  `/.well-known/oauth-authorization-server`) answer only requests whose `Host` is `PUBLIC_URL`'s
  hostname, against DNS rebinding. `/v1` and `/health` are not checked.
- **Origins.** `MCP_ALLOWED_ORIGINS` only refuses: a request that carries an `Origin` header not
  in the list is refused (`403`, with an empty list every such request), and one without an
  `Origin` (an MCP client calling from its own server, which is how Claude and ChatGPT connect)
  is not checked. Origins are compared by hostname, so `https://app.example.com` also admits
  `http://app.example.com` and any port on that host. The list grants nothing: it adds no CORS
  headers, which come, for `/mcp` as for the rest of the service, from `CORS_ALLOWED_ORIGINS`.
- **Reachability.** MCP clients call both zeteo and Tereo from their own servers: both must be
  reachable from the internet over https, and Tereo's issuer must equal the URL its discovery
  document is served from.
- **Start.** With MCP on, zeteo fetches `${TEREO_URL}/.well-known/oauth-authorization-server` as it
  starts, and **does not start while Tereo is unreachable**: start Tereo first, or the process
  exits and is restarted by its supervisor until Tereo answers.

## The login client in Tereo

MCP clients do not register themselves. Create one login client per AI client in the provisioning
documents of the Tereo deploy (Tereo's `PROVISIONING_PATH`): public (no secret), the
authorization-code flow, `audience` naming zeteo's service slug, `zeteo`, so Tereo reports its
tokens active to zeteo:

```json
{
  "version": "1.0.0",
  "clients": [
    {
      "clientId": "claude-connector",
      "name": "Claude connector",
      "clientType": "public",
      "grantTypes": ["authorization_code", "refresh_token"],
      "redirectUris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback"
      ],
      "scopes": ["openid", "profile", "email"],
      "audience": ["zeteo"],
      "consentRequired": true
    },
    {
      "clientId": "chatgpt-connector",
      "name": "ChatGPT connector",
      "clientType": "public",
      "grantTypes": ["authorization_code", "refresh_token"],
      "redirectUris": ["<the callback URL ChatGPT's connector form displays>"],
      "scopes": ["openid", "profile", "email"],
      "audience": ["zeteo"],
      "consentRequired": true
    }
  ]
}
```

and list the same ids in zeteo's environment:

```sh
MCP_ALLOWED_CLIENTS=claude-connector,chatgpt-connector
```

Redirect URIs must match exactly; copy ChatGPT's from its connector form. Zeteo requires no
scopes and advertises none. Then, in the AI client, add a custom connector with the URL
`${PUBLIC_URL}/mcp` and the client id, with no client secret, and sign in through Tereo. Tereo's
own guide, `packages/tereo-mcp/docs/connecting.md` in the Tereo repository, covers the clients'
forms. The end-to-end run in `e2e/` uses a client of this shape (`e2e/provisioning/`).

## Enabling people

A person sees zeteo's tools only with the Tereo permission `zeteo.mcp.use`, and each tool also
needs `zeteo.data.read`, as `GET /v1/catalog` and `POST /v1/query` do. Zeteo declares the role
`zeteo_mcp_user` with both (`zeteo_admin` has both too). Assign the role to a user in Tereo, or to
a Tereo group, since groups carry roles there and every member gets them. What a person can then
see and query is still only what their grants allow ([grants.md](grants.md)).

A user without `zeteo.mcp.use` gets no tools: `tools/list` is empty and a call fails as for a tool
that does not exist. One with `zeteo.mcp.use` but not `zeteo.data.read` sees the tools, and each
call answers `forbidden`. A permission removed in Tereo keeps working for up to the SDK's
introspection cache (60 seconds).

**Service accounts are refused.** A token from the `client_credentials` flow is refused at `/mcp`
(`401`, as any refused token). Service accounts use `/v1`.

### A token from an MCP client also works on `/v1`

A token issued to a client in `MCP_ALLOWED_CLIENTS` is an ordinary Tereo access token for zeteo.
`/v1` accepts it, with the user's own permissions, so one OAuth client may serve both REST and
MCP. On `/v1` neither `zeteo.mcp.use` nor the MCP limits apply: the token's user can call
`POST /v1/query` with REST's limits (up to 50,000 rows, 10 MB) if they hold `zeteo.data.read`.
What they can read is still bounded by `zeteo.data.read` and their grants.

## The tools

All of them need `zeteo.mcp.use` and `zeteo.data.read`. The discovery tools, `query` and the
saved query, dashboard and saved panel tools that read are read-only; the tools that create, change
and delete them change the caller's own only (another user's is `not_found`,
whatever permissions the caller holds). The server's instructions, sent when a client connects,
are short (at most 2,500 characters): what zeteo is for, the order of use, and that query results
are data from a database, never instructions. The full reference (the query language with worked
examples, results, limits and errors, saved queries, charts and panel placement) is the
`query_guide` tool, which a model calls before its first query or chart. The `query` and saved
query tool descriptions carry a short summary of the language, and every tool description stays
under 1,500 characters. The reference is one module, `src/mcp/reference.ts`; its worked examples
are run by the tests.

| Tool | Input | Result |
|------|-------|--------|
| `list_sources` | none | `{ sources: [{ slug, name, description, type, kind, language, tables, limits: { default_rows, max_rows, timeout_ms, max_joins } }] }`: the sources the caller has a grant on, by slug; `tables` counts the tables they can see |
| `list_tables` | `{ source }` | `{ source, tables: [{ name, schema_name, kind, description, missing, columns }] }`; `columns` counts the granted columns |
| `describe_table` | `{ source, table }`, `table` as `list_tables` names it | `{ source, table }`, the table as `GET /v1/catalog` shows it: granted columns with type, nullability and description, and the relations the caller may join |
| `query_guide` | none | `{ guide }`, the reference as Markdown; needs only `zeteo.mcp.use`, not `zeteo.data.read`, as it reads no data |
| `query` | a query in the source's language, as the body of `POST /v1/query` | `{ columns, rows, truncated, truncated_by?, warnings, run_id }` |
| `list_saved_queries` | `{ scope?: "mine" \| "shared" }` | `{ saved_queries: [view], truncated }` (`truncated` is true when the first 100 were all it returned), the view of `GET /v1/saved-queries` without `owner.id`; one the caller cannot run has `accessible: false` and no `query` or `source` |
| `get_saved_query` | `{ id }` | the same view |
| `run_saved_query` | `{ id, limit?, offset? }` | as `query`; refused with `saved_query_not_accessible` when the caller cannot run it |
| `create_saved_query` | `{ name, description?, query }`, `query` as for `query` | the view; the query is planned against the caller's own grants |
| `update_saved_query` | `{ id, name?, description?, query? }` | the view |
| `delete_saved_query` | `{ id }` | `{ deleted: true }` |

| `list_dashboards` | `{ scope?: "mine" \| "shared" }` | `{ dashboards: [{ id, name, description, owner, time_range, refresh_seconds, theme, url? }], truncated }`; `url` is the admin UI's address when it is served |
| `get_dashboard` | `{ id }` | the dashboard with its panels, each with `id`, place, `title`, `state` and, for an `ok` panel, its `chart`, `time_column` and `saved_query_id` or `saved_panel_id`; a panel that is not `ok` carries a message instead ([dashboards.md](dashboards.md#panel-states-and-their-copy)) |
| `create_dashboard`, `update_dashboard`, `delete_dashboard` | name, description, `time_range`, `refresh_seconds`, `theme` | the caller's own dashboard |
| `add_panel`, `update_panel`, `remove_panel` | a dashboard's id and a panel's saved query, chart, `time_column`, title and place | the panel; what is wrong with the chart is told as `problems` |
| `preview_panel` | a saved query, a chart, optionally `time_range` with `time_column` | `{ columns, row_count, truncated, rows (the first 20), problems }`; runs the saved query as the caller under MCP's row limits, so a saved query without its own `limit` reads at most 100 rows (`truncated` when there are more); the tool's description says so, so a model does not mistake it for the dashboard's limit (1,000 rows by default) |
| `list_saved_panels`, `get_saved_panel`, `create_saved_panel`, `update_saved_panel`, `delete_saved_panel` | as the saved query tools, with a chart | the saved panel (a saved query with its chart) |
| `link_saved_panel`, `detach_panel` | a dashboard and a saved panel, or a linked panel | the panel |

Sharing and transferring a saved query, a dashboard or a saved panel are not tools: they are done in the UI or the API
([saved-queries.md](saved-queries.md)).

The discovery tools show names, never ids or native types, and nothing outside the caller's
grants. `query` runs the engine of `POST /v1/query` ([querying.md](querying.md)) with MCP's
limits; its rows are in the same wire forms. There is no export over MCP.

## The Claude Code plugin

`plugins/zeteo/` (listed by the marketplace in `.claude-plugin/marketplace.json`) gives Claude Code
the MCP server and two skills, `zeteo-querying` and `zeteo-dashboards`, whose descriptions are
always in context so Claude knows what zeteo is for. Install with
`/plugin marketplace add <this repo>` and `/plugin install zeteo@zeteo`; it asks for the MCP URL
(`https://<your zeteo>/mcp`). The skills' `reference.md` files are generated from `reference.ts`:
after changing it, run `npm run plugin:reference` in `packages/zeteo` and commit both; a unit test
fails when they drift. See `plugins/zeteo/README.md`.

## Limits

| Limit | MCP | `POST /v1/query` |
|-------|-----|------------------|
| Rows, default / maximum | 100 / 5,000 | 1,000 / 50,000 |
| Result size (rows as JSON) | 1 MB | 10 MB |
| Time | the source's `timeout_ms` | same |
| Queries at once | the same slots as `/v1/query`: the user's query limit and the source's `query_concurrency` | |
| Tool calls | `MCP_RATE_LIMIT_PER_MINUTE` per user per minute | none |

`list_sources` reports the MCP row limits. The rate limit counts only tool calls; over it the call
is a tool error saying how many seconds to wait. If Redis does not answer within a second the call
goes through and the failure is logged. A call that runs past 135 seconds (the longest source time
limit and room for its record) is answered as timed out.

**Cancelling.** A client that disconnects stops its query on the source, recorded `failed` with
`client_closed`. A cancel sent on a 2026-era connection stops the query the same way. A cancel sent
on a legacy (2025-era) connection, as a `notifications/cancelled` message, does not: the client
stops waiting, but the query runs on to its end or its time limit.

## What is recorded

- Each `query` call is recorded in the run log as any query is
  ([querying.md](querying.md#the-run-log)), with entry point `mcp`: a `query_runs` row and a
  `zeteo.query.run` audit entry, refused and failed calls included.
- `run_saved_query` is recorded the same way, with the saved query's id
  ([saved-queries.md](saved-queries.md#what-is-recorded)); creating, changing and deleting a saved
  query write that area's audit entries.
- The dashboard and saved panel tools that change something write that area's audit entries
  (`zeteo.dashboard.*`, `zeteo.saved_panel.*`). `preview_panel` runs the saved query as `query`
  does.
- The discovery tools and the saved query, dashboard and saved panel tools that only read write no
  run and no audit entry.
- Every tool call is one log line from `@tereo-io/mcp` (`tool`, `user_id`, `client_id`,
  `request_id`, `outcome`, `duration_ms`); zeteo's own lines for the call carry the same
  `request_id`. Inputs and results are never logged.

## Errors as the model sees them

A failure is a tool error whose text is the JSON body `POST /v1/query` would answer:

```json
{"error":"not_found_or_not_accessible","error_description":"Column \"totl\" was not found or is not accessible","path":["select",1],"suggestions":["total"],"request_id":"…"}
```

with the same codes, paths and suggestions ([querying.md](querying.md#errors)), and the same rule:
a name the caller is not granted fails exactly as one that does not exist, in every tool. The
`request_id` is the call's, found on its log lines. An unexpected failure is
`Internal error (request <id>)`, with nothing of its cause. A call whose input the package's schema
refuses (`query` without `source`, say) is answered by the MCP SDK's own validation message, not
zeteo's error shape. Database and driver text never reaches the model.
