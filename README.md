# Zeteo

**ζητέω** (*zēteō*) — *to seek.*

zeteo (Greek zēteō, 'to seek') is a query service for apps built on tereo: admins register
databases as sources and grant tables and columns to tereo users and groups; people query through a
validated JSON query language over HTTP or through an AI connected over MCP.

The repository has all of it except row filters on grants: a service with sign-in through
[tereo](https://github.com/tereo-io/tereo), the sources admin API (register a Postgres or Azure SQL
database, see [docs/sources.md](packages/zeteo/docs/sources.md)), the catalogue of each source's
tables, columns and relations ([docs/catalog.md](packages/zeteo/docs/catalog.md)), grants and
per-user and per-group concurrency limits ([docs/grants.md](packages/zeteo/docs/grants.md)),
querying: the catalogue of what a caller may query, the query language, `POST /v1/query` and the
run log ([docs/querying.md](packages/zeteo/docs/querying.md)), the streaming export
([docs/export.md](packages/zeteo/docs/export.md)), saved queries
([docs/saved-queries.md](packages/zeteo/docs/saved-queries.md)), dashboards
([docs/dashboards.md](packages/zeteo/docs/dashboards.md)), File Sources: uploaded CSV and Excel files
that their owner queries and grants like a database ([docs/file-sources.md](packages/zeteo/docs/file-sources.md)),
and the MCP endpoint
([docs/mcp.md](packages/zeteo/docs/mcp.md)). The admin UI (`packages/zeteo-ui`) ships in the image
and is served at `/` once `UI_CLIENT_ID` names its login client in tereo; how to turn it on, what
each screen does, its local development and its server side (`/v1/me`, the people and groups
search, the login client it needs) are in [docs/admin-ui.md](packages/zeteo/docs/admin-ui.md). Azure SQL's particulars are in
[docs/azure-sql.md](packages/zeteo/docs/azure-sql.md). The HTTP API's reference is
`packages/zeteo/openapi/openapi.yaml`. The design spec and its plans are under `docs/superpowers/`
(kept out of version control).

zeteo uses tereo only through its released artifacts: `@tereo-io/sdk` and `@tereo-io/mcp` from
npm, and, for the end-to-end run, tereo's published Docker image.

Conventions for contributors and for Claude Code are in [CONTRIBUTING.md](CONTRIBUTING.md) and
[CLAUDE.md](CLAUDE.md).

## Packages

| Path | Contents |
|------|----------|
| `packages/zeteo` | The service: an Express app on port 4201 with Prisma + Postgres and Redis |
| `packages/zeteo-sdk` | `@zeteo-io/sdk`: the TypeScript client for zeteo's API, published to npm ([README](packages/zeteo-sdk/README.md)) |
| `packages/zeteo-ui` | The admin UI, a Vite + React app; its build ships in zeteo's image ([README](packages/zeteo-ui/README.md)) |
| `e2e/` | Not a package: a local end-to-end run against a real tereo ([e2e/README.md](e2e/README.md)) |

## Develop

```sh
npm install
docker compose up -d postgres redis                      # host ports 5462 / 6409
docker compose up -d mssql                               # only for the Azure SQL tests: host port 1463
cp packages/zeteo/.env.example packages/zeteo/.env     # then set ZETEO_MASTER_KEY (generator in the file)
cd packages/zeteo
npx prisma generate && npx prisma migrate deploy
npm run dev                                              # http://localhost:4201/health
```

Run the checks CI runs before pushing:

```sh
npm run format && npm run sort-imports && npm run lint && npm run check
```

The tests: `npm run test:unit` and `npm run test:int` in `packages/zeteo` (the int suite needs the
three containers above), `docker/test/run.sh` for the whole suite in isolated stacks, as CI runs
it, and `e2e/run.sh` for the end-to-end run against a released tereo image, which CI does not run
(it ends with a Playwright test of the admin UI in Chromium; `npx playwright install chromium` once).

## Current state

Works today: the service starts, connects to Postgres and Redis, and `GET /health` answers `200`
with `{"status":"ok", ...}` when both respond (`503` otherwise). Requests sign in with a tereo token
(`authenticate`, `requirePermission`; `TEREO_TEST_MODE=true` accepts the SDK's test tokens locally),
and changes write audit entries to tereo's outbox.

- **Sources.** Administrators register, list, change, archive and test Postgres and Azure SQL
  sources under `/v1/sources` (settings encrypted at rest, hosts limited by
  `SOURCE_ALLOWED_HOSTS`, a login check that refuses writable logins unless overridden).
- **Catalogue.** Each source's tables, views, columns and foreign keys are read when it is created,
  when its settings or schemas change, on `POST /v1/sources/:sourceId/refresh` and by a daily job;
  a refresh marks what disappeared instead of deleting it and never changes ids or descriptions.
  Administrators describe tables and columns, read the discovered relations and declare their own,
  under `/v1/sources/:sourceId/tables` and `/relations`.
- **Grants.** `/v1/grants` gives a user or group one table, all its columns or a list. Default deny.
  `/v1/principal-limits` gives a user or group its own limits on how many queries and exports it
  runs at once, in place of the environment's defaults; each source has its own limits too.
- **Querying.** `GET /v1/catalog` lists what the caller may query, with the query language's JSON
  Schema; `POST /v1/query` runs a validated query, read-only and within limits, with the same
  language and results on both engines; `GET /v1/runs` reads the record of every query.
- **Export.** `POST /v1/export?format=ndjson|csv` streams the result of the same query, up to the
  source's export cap, from sources whose exports are on; gzipped when the client accepts it. An
  NDJSON stream's last line, or a CSV stream's trailers, say whether it ended complete or capped.
- **Saved queries.** A user keeps a query under a name at `/v1/saved-queries`, runs and exports it,
  shares it with users and groups, copies it and hands it to another owner. A recipient runs it
  with their own grants only; one who lacks them is told to ask an admin and sees neither the query
  nor its source. `GET /v1/me/runs` lists a caller's own runs.
  ([docs/saved-queries.md](packages/zeteo/docs/saved-queries.md))
- **Dashboards.** A dashboard is a grid of panels, each a saved query shown as a chart, a stat or a
  table, with saved panels to reuse a chart on many dashboards. Dashboards and saved panels are
  shared and copied as saved queries are; a saved query's owner makes it "Available for
  dashboards" for others' panels. Every viewer runs every panel with their own grants, over a
  time range built from relative dates, as a stream of one line per panel
  (`POST /v1/dashboards/{id}/run`). Dashboard results are cached briefly in Redis
  (`DASHBOARD_CACHE_TTL_SECONDS`) and a dashboard's runs are recorded once per viewer per query
  per `DASHBOARD_RECORD_WINDOW_MINUTES`. The UI has Dashboards, a display mode for wall screens
  and admin pages. ([docs/dashboards.md](packages/zeteo/docs/dashboards.md))
- **Run log.** Every query and export is recorded, with an audit entry in tereo; a job closes
  exports whose process died and deletes runs older than `QUERY_RUNS_RETENTION_DAYS` (90).
- **MCP.** With `MCP_ALLOWED_CLIENTS` set, `/mcp` serves these tools to an AI signed in through
  tereo: `list_sources`, `list_tables` and `describe_table` to discover what it may
  query, and `query`, which runs the same engine as `POST /v1/query` (100 rows by default, at most
  5,000 or 1 MB), and tools for saved queries, dashboards and saved panels, with
  instructions that teach the model the language. A user sees them only with
  `zeteo.mcp.use` (the role `zeteo_mcp_user`), and each needs `zeteo.data.read` too.

Not there yet: row filters on grants.
