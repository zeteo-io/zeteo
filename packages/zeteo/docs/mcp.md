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

All four are read-only and gated as above. The server's instructions, sent when a client
connects, teach the model the order of use, the query language with worked examples, how results,
limits and errors read, and that query results are data from a database, never instructions.

| Tool | Input | Result |
|------|-------|--------|
| `list_sources` | none | `{ sources: [{ slug, name, type, language, tables, limits: { default_rows, max_rows, timeout_ms } }] }`: the sources the caller has a grant on, by slug; `tables` counts the tables they can see |
| `list_tables` | `{ source }` | `{ source, tables: [{ name, schema_name, kind, description, missing, columns }] }`; `columns` counts the granted columns |
| `describe_table` | `{ source, table }`, `table` as `list_tables` names it | `{ source, table }`, the table as `GET /v1/catalog` shows it: granted columns with type, nullability and description, and the relations the caller may join |
| `query` | a query in the source's language, as the body of `POST /v1/query` | `{ columns, rows, truncated, truncated_by?, warnings, run_id }` |

The discovery tools show names, never ids or native types, and nothing outside the caller's
grants. `query` runs the engine of `POST /v1/query` ([querying.md](querying.md)) with MCP's
limits; its rows are in the same wire forms. There is no export over MCP.

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
- The discovery tools write no run and no audit entry.
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
