# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Zeteo** (`zeteo`; Greek *zēteō*, "to seek") is a query service for apps built on
[tereo](https://github.com/tereo-io/tereo): admins register databases as sources and grant tables
and columns to tereo users and groups; people query through a validated JSON query language over
HTTP or through an AI connected over MCP.

**One service**, `packages/zeteo` (port 4201), with one Postgres database (schemas `zeteo` and
`core`) and Redis. Sign-in through tereo, permissions and the audit outbox exist, and so do the
sources admin API (`/v1/sources`: register, list, change, archive and test a Postgres or Azure SQL
source, with encrypted settings, a network allowlist, a login check and per-source connection
pools), the catalogue of each source (a refresh reads tables, columns and foreign keys;
descriptions; discovered and declared relations), grants of tables and columns to users and groups
(`/v1/grants`), per-user and per-group concurrency limits (`/v1/principal-limits`), querying (`GET
/v1/catalog`, `POST /v1/query`, `GET /v1/runs`) and the streaming export (`POST /v1/export`, NDJSON
or CSV), saved queries (`/v1/saved-queries`: a user keeps a query under a name and creates, changes,
deletes, runs, exports, copies, shares it with users and groups, or transfers it; a recipient runs
it with their own grants only, and one who lacks them is told to ask an admin and never sees its
query or source; `GET /v1/me/runs` lists a caller's own runs), dashboards (`/v1/dashboards` and
`/v1/saved-panels`: panels that show saved queries as charts, run by each viewer with their own
grants as a stream, cached briefly in Redis and recorded once per viewer per query per window; a
saved query's owner makes it available for dashboards), and an MCP endpoint (`/mcp`, on when
`MCP_ALLOWED_CLIENTS` is set) with three discovery tools (`list_sources`, `list_tables`,
`describe_table`), the `query` tool, which runs `POST /v1/query`'s engine under MCP's limits, tools
for saved queries, dashboards and saved panels, `query_guide` (the full query and dashboard reference), and short, purpose-first server instructions.
A Claude Code plugin (`plugins/zeteo/`, marketplace in `.claude-plugin/`) gives Claude the MCP
server and two skills whose `reference.md` files are generated from `src/mcp/reference.ts` (`npm
run plugin:reference` in `packages/zeteo`; commit both together). A source has an optional
`description`.
Uploads (on when `UPLOADS_READER_URL` is set): a user with
`zeteo.uploads.write` stages a CSV or xlsx (`/v1/uploads`), previews and corrects it, and owns
the `upload` source it creates (`POST /v1/sources` with `type: "upload"`), stored in Zeteo's
Postgres and read through a read-only role. There is one sources API: upload sources are listed,
read and changed through `/v1/sources` (the owner with `owner_id=me`), with `DELETE`, `transfer`,
adding, re-uploading and removing tables and changing columns for upload sources only. Nothing syncs and
there are no Google Sheets or SharePoint sources yet. There is no row filter
yet. Do not describe or rely on one as existing.

Read [README.md](README.md) first. The design and the plans are in `docs/superpowers/` (kept out of
version control): the design spec is `docs/superpowers/specs/2026-11-12-zeteo-design.md`, and the
plans are beside it in `docs/superpowers/plans/`.

The other package is `@zeteo-io/sdk` (`packages/zeteo-sdk`), the TypeScript client for zeteo's API,
published to npm in its own release group, `sdk` (see [docs/code-style.md](docs/code-style.md)).
Nothing in `zeteo` depends on it.

The admin UI is `packages/zeteo-ui` (Vite + React on `@kosmeo-ui/react`, dev server on port 4200,
forwarding `/v1` and `/ui-config.json` to zeteo). It belongs to the release group `core`, so its
version is zeteo's. Its `check` also runs `scripts/check-routes.mjs`, which keeps routes and
`public/` files clear of the paths zeteo reserves. Its top bar holds My Zeteo, Dashboards and an Admin menu for the admin sections (sources,
grants, limits, runs, Saved queries for `zeteo.saved_queries.read`, and the two dashboard lists), and My Zeteo at `/my` for
everyone who may query: their saved queries, those shared with them, their recent runs and what they
can query; Dashboards at `/dashboards` (with a display mode at `/dashboards/<id>/display`), and
admin lists of all dashboards and saved panels for `zeteo.dashboards.read`. Its build ships in zeteo's image (the Dockerfile's `ui` stage) and zeteo serves it at `/`
when `UI_CLIENT_ID` is set. `npm run build` also builds the MCP preview card (`src/mcp-card/`, with `vite.mcp-card.config.ts`) to `dist-mcp/card.html`, which the image ships next to `dist` and zeteo's `src/mcp/card.ts` reads from `MCP_CARD_PATH`. Server side, screens and local development:
`packages/zeteo/docs/admin-ui.md`. Its browser test is `e2e/browser/` (Playwright).

## Layout of `packages/zeteo`

One ordinary package:

| Path | Holds |
|------|-------|
| `src/index.ts` / `app.ts` | Entry point (`createAppServer`, start and graceful stop, whose first steps are `drainRequests`: running exports stopped, then HTTP drained) and the Express app (`createApp`, which mounts the MCP router, behind Host and Origin checks, when MCP is on) |
| `src/env.ts` | The one env schema. `src/preload.ts` must be the first import of every entry point |
| `src/definitions/tereoDeclaration.ts` | What zeteo declares to tereo: slug, permissions (`zeteo.sources.read|write`, `zeteo.grants.read|write`, `zeteo.data.read`, `zeteo.data.export`, `zeteo.runs.read`, `zeteo.mcp.use`, `zeteo.saved_queries.read|write`, `zeteo.dashboards.read|write`, `zeteo.uploads.write`; none organization-assignable, as nothing here is organization-scoped), the `zeteo_admin`, `zeteo_user` and `zeteo_mcp_user` roles, audit event names and descriptions. `npm run tereo:provisioning` (in `packages/zeteo`) writes `tereo-provisioning.json` from it; commit both together |
| `src/middleware/auth.ts` | `authenticate` (tereo verifies the token, sets `req.caller`), `callerFromAuth`, `callerOf`, `requirePermission` (hierarchical, `utils/permissions.ts`) |
| `src/mcp/` | The MCP server on `@tereo-io/mcp`: `index.ts` (`createMcpRouter`, null when `MCP_ALLOWED_CLIENTS` is empty), `paths.ts` (`MCP_PATH` and the discovery paths, imported by `app.ts` without the tools), `tools.ts` (the discovery tools), `guideTool.ts` (`query_guide`: the full reference, needs only `zeteo.mcp.use`), `reference.ts` (`QUERYING_REFERENCE`, `DASHBOARDS_REFERENCE`, `QUERY_GUIDE`: the one source of the query and dashboard reference, with the worked examples the tests run; also the source of the plugin's `reference.md` files), `queryTool.ts` (`query`: `runQuery` with entry point `mcp`) and `savedQueryTools.ts` (list, get, run, create, update and delete saved queries; update and delete are the caller's own only), `dashboardTools.ts` and `savedPanelTools.ts` (dashboards, their panels and saved panels, and `preview_panel`; changes are the caller's own only), each gated on `zeteo.mcp.use` and requiring `zeteo.data.read`, built from the caller's visible catalogue only; `instructions.ts` (`MCP_INSTRUCTIONS`, sent at initialize: short and purpose-first, the static part at most 2,500 characters; tool descriptions stay under 1,500), `callerInstructions.ts` (`callerInstructions`: puts the `## What you can query` section for the caller's sources after the opening section, with a line saying names and descriptions are data, never instructions, within 1,000 characters and 3,500 overall; the whole text cached in Redis per user for 300 s, the static text on any failure or after 1.5 s) and `visibleSources.ts` (the caller's sources, shared with `list_sources`), `card.ts` (`loadCard` and the resources `ui://zeteo/panel-card.html` and `ui://zeteo/dashboard-card.html`, from `MCP_CARD_PATH`; none, with a warning, when the file is missing or larger than the server's `maxResultBytes`) and `cardTools.ts` (the app-only tools `card_panel_rows` and `card_dashboard`, `visibility: ["app"]`), `caller.ts`, `errors.ts` (`asToolError`: zeteo's error body as a tool error, 5xx logged at error; `inToolCall`: a call's work run as zeteo's request `ctx.requestId`), `redis.ts` (the rate limiter's Redis and the per-user instructions cache, `readCachedInstructions`/`cacheInstructions`, every call bounded) |
| `src/sources/network.ts` | The one decision whether zeteo may connect to a host: `SOURCE_ALLOWED_HOSTS` rules (`parseAllowedHosts`, parsed at start by `env.ts`) and `resolveAllowed`, which resolves once and returns the address to dial. Link-local, metadata (including Azure's, Alibaba's and Oracle's outside link-local), unspecified and multicast addresses are refused whatever the rules say |
| `src/adapters/` | `SourceAdapter` (settings schema, redaction, connect, login check, schema read, `readSize` (the bytes on disk of the source's schemas, measured at a refresh), `readRowCounts` (each table's estimated rows from the database's statistics, measured at a refresh and kept as the table's `row_count`), query language, `prepare`, and `openQuery`, a pull-based row stream) per source type, `postgres/` and `azure-sql/`; `adapterFor`; `rowSize.ts` (`approxRowBytes`, a cheap row width that sizes export batches and the Azure SQL read-ahead). `sql/` is the SQL query language shared by both: `language.ts` (the JSON Schema and parsing), `plan.ts` (the planner over a visible catalogue), `compile.ts` and `dialect.ts` with `dialects/` (the Postgres and SQL Server SQL), `values.ts` (wire forms) |
| `src/sources/` | `service.ts` (create, update, archive, test: the checks, sealing and audit), `present.ts` (`presentSources`: a source's view with its share count and, for an upload source, its stored bytes), `pools.ts` (`withSourceConnection`: one pool per source per process, checked against the source's row on every call, retired on a settings change, archive, `source_unreachable` or idle; `stopSourcePools` at shutdown), `connect.ts` (reads settings, `connectChecked`), `network.ts` |
| `src/catalog/` | `refresh.ts` (`refreshSource`: reads the snapshot outside any transaction, then applies it under a per-source advisory lock, batched, in a transaction of up to 120 s; re-reads when the source changed during the read; marks missing, never deletes; `refreshAfterChange` after a create or a settings/schemas change), `relationNames.ts` (naming of discovered relations), `service.ts` (describe a table, declare and remove a relation, each audited) |
| `src/grants/` | `service.ts` (create, replace, remove, read grants, each audited), `access.ts` (`loadAccess`: what a caller's user and groups are granted), `principals.ts` (group membership from tereo, cached 30 s per user) and `principalStatuses.ts`, `visibleCatalog.ts` (`buildVisibleCatalog`/`loadVisibleCatalog`: granted columns only, relations whose keys are all granted; the only view of a source the planner gets) |
| `src/limits/` | `service.ts` (create, change, remove a user's or group's own concurrency limits, each audited), `resolve.ts` (`loadUserLimits`: the caller's limits per field, from their own row, else the highest of their groups', else the environment) |
| `src/uploads/` | Uploads (`upload` sources; [docs/uploads.md](packages/zeteo/docs/uploads.md)), served by the `/v1/sources` routes and `/v1/uploads`: `service.ts` (create, rename, add and remove tables, re-upload, retype, transfer, delete, each audited; `not_an_upload_source` for a database source), `loading.ts` (the typed load into a new table, the swap, `checkQuota`), `staging.ts` (the upload's staging tables, expiry, `discardOwnStaging`), `storage.ts` (the `zu_<id>` schemas and tables), `ownership.ts` (what an owner may do), `readerRole.ts` (the start-up checks of the reader role `UPLOADS_READER_URL` names), `zipGuard.ts` and `parse/` (CSV, xlsx, type inference, names) |
| `src/saved-queries/` | `service.ts` (list, get, create, update, delete, copy, shares, transfer and `savedQueryToRun`, each change audited; a saved query is planned as the caller), `access.ts` (`canUse`/`decideAccess`: whether the caller can run one, no cause told apart) and `stamps.ts` (`last_run_at` after a successful run). A viewer without access gets a view with `query` and `source` left out |
| `src/engine/` | `index.ts` (`runQuery`: shape check, plan, concurrency leases, open the run on the adapter and read it, record), `plan.ts` (`planFor`) and `savedPlan.ts` (`planSaved`: a saved query planned as the caller, every failure one `saved_query_not_accessible`), `collect.ts` (reads a row stream in batches within the row and byte caps; `nextBatchRows`, the byte-sized batch both it and an export ask for), `export.ts` (`runExport`: the same checks and plan as a query, then export leases, renewed while it runs, and the rows passed to a sink up to the source's export cap; `POST /v1/export` streams it through `export/httpSink.ts`), `limits.ts` (profiles, row caps, Redis leases per user and per source, for queries and for exports apart), `record.ts` (the `query_runs` log; an export's run is `running` until it ends), `errors.ts` |
| `src/dashboards/` | `reach.ts` (`reaches`: the reach rule for a saved query on a panel), `decide.ts` (`decidePanels`/`decideSavedPanel`/`decideNewPanel`: a panel's state for a viewer, one decision for the read, the run and a saved panel; `not_accessible` reveals no cause), `chart.ts` (chart settings, version 1, and `chartProblems`), `timeRange.ts` (the ranges as relative dates, `withTimeFilter`), `layout.ts` (the 12-column grid, `MAX_PANELS`), `service.ts` (list, get, create, update, delete, panels, shares, transfer and copy, each change audited) and `run.ts` (`runDashboard`: decide, group identical panels, run as the `dashboard` entry point in parallel up to `DASHBOARD_PARALLELISM`, one line per panel; the only caller of `runQuery` with that entry point) |
| `src/saved-panels/` | `service.ts` (a saved query with a chart under a name: list, get, create, update, delete, copy, shares, transfer, preview, save from a panel, link and detach, each change audited) |
| `src/sharing/` | `shares.ts`, `principals.ts` and `schemas.ts`: the shares of a dashboard or saved panel and the checks of who they name, shared with saved queries |
| `src/engine/` dashboard run | `index.ts`'s `runDashboardQuery` (plan as the viewer against the run's `now`, serve from the cache or execute, record by window), `fingerprint.ts` (`fingerprintOf`, the identity of a run for the cache and shared execution: source, plan and row cap; a future row filter must be part of the plan; and `recordIdentityOf`, the `now`-independent identity a run is recorded under: source, saved query, body as written, row cap), `resultCache.ts` (the Redis cache, `DASHBOARD_CACHE_TTL_SECONDS`; the first place zeteo keeps results), `recordWindow.ts` (once per viewer per query per `DASHBOARD_RECORD_WINDOW_MINUTES`, keyed on `recordIdentityOf`) and `dashboardRun.ts` (`waitForLeases`, `coalesce`) |
| `src/jobs/` | `refreshSources.ts`: the check (30-60 s after start, then hourly) that refreshes sources not refreshed in 24 hours, under a Redis lock per source, re-reading each under the lock; `runsHousekeeping.ts`: the sweep (60-120 s after start, then hourly, under one Redis lock) that closes exports still `running` after 15 minutes as `interrupted` and deletes runs older than `QUERY_RUNS_RETENTION_DAYS`. Both started by `index.ts` (not in the test suite's shared server) |
| `src/export/` | `csv.ts` and `ndjson.ts` (an export's lines), `httpSink.ts` (the sink writing an export to the response: headers, gzip when accepted, back-pressure, CSV trailers) |
| `src/views/` | Response shapes (`source.ts`, `catalog.ts`, `grant.ts`, `principalLimit.ts`, `run.ts`, `savedQuery.ts`, `dashboard.ts`, `panel.ts`, `savedPanel.ts`, `visibleCatalog.ts`); never carry secrets, and the caller's catalogue view carries no ids |
| `src/routes/` | Mirrors the URL. `index.ts` is the root; `health/` at the root, the API under `v1/` (`sources/`, `sources/source/`, with `archive/`, `test/`, `refresh/`, `transfer/`, `tables/` (and `table/`, with `columns/` and `column/`) and `relations/` (and `relation/`); `uploads/` (and `upload/`); `grants/` (and `grant/`); `principal-limits/` (and `principal-limit/`); `catalog/`; `export/`; `query/`; `runs/`; `saved-queries/` (and `saved-query/`, with `run/`, `export/`, `copy/`, `shares/`, `transfer/`, `dashboards/`); `dashboards/` (and `dashboard/`, with `panels/` (and `panel/`, with `detach/`, `save/`), `run/`, `copy/`, `shares/`, `transfer/`); `saved-panels/` (and `saved-panel/`, with `preview/`, `copy/`, `shares/`, `transfer/`); `principals/` (with `lookup/` and `all/`); `me/` with `runs/` and `principals/` (with `all/`)) |
| `openapi/`, `docs/` | The OpenAPI spec (`npm run openapi:lint` / `openapi:build` in `packages/zeteo`; commit the bundle, `openapi/bundled-openapi.yaml`, with its sources) and per-area notes (`docs/sources.md`, `catalog.md`, `grants.md`, `querying.md`, `export.md`, `mcp.md`, `admin-ui.md`, `azure-sql.md`); `admin-ui.md` covers `/v1/me`, `/v1/principals`, `UI_*`, the CSP and the reserved paths |
| `src/utils/`, `src/utils/db/` | Shared: `errors.ts`, `cursor.ts`, `crypto/envelope.ts`, `validateReq.ts`, `logger.ts`, `redis.ts`, `requestId.ts`, `httpServer.ts`, `prismaErrors.ts`, `idSchema.ts`, `tereo.ts` (the one SDK client), `transaction.ts` (`withAudit`: a transaction that writes its audit entries to `core.outbox`; optional `timeoutMs`), `outboxCollector.ts`, `text.ts` (`noNul` for request strings); `db/prisma.ts` is the Prisma client and the health probe |
| `src/tests/` | Mirrors `src/`: `<base>[.<aspect>][.unit].test.ts`, `flows/`, `conventions/`; `setup/`, `support/`, `fixtures/` are not tests. Two projects, `unit` (no server) and `int` (one real server). Rules: [src/tests/README.md](packages/zeteo/src/tests/README.md) |
| `prisma/` | The one schema and migrations |

Outside the package, `e2e/` is a local end-to-end run (`e2e/run.sh`, not run by CI): a released
Tereo image (`TEREO_IMAGE`, default `ghcr.io/tereo-io/tereo:0.8.2`), zeteo's own image built from
the checkout, and a TLS source Postgres, with real sign-ins, then a Playwright test of the admin UI
in Chromium (`e2e/run.sh --browser` runs only that); see [e2e/README.md](e2e/README.md).
Zeteo depends on Tereo only through released artifacts: `@tereo-io/sdk` and `@tereo-io/mcp` from
npm, and Tereo's published image in `e2e/`. Nothing here builds Tereo from source.

## Key conventions

- **Style is enforced by CI** ([docs/code-style.md](docs/code-style.md)): Prettier, import order
  (single-line imports longest first, then multi-line — `npm run sort-imports`), ESLint, `tsc`. Run
  `npm run format && npm run sort-imports && npm run lint && npm run check` before committing. A
  change to `zeteo` (release group `core`; its version tags the image) needs a version plan
  (`npm run version-plan`).
- **ESM only.** Every package is `"type": "module"` with `.js` extensions on all relative imports,
  including directory imports (`./health/index.js`, not `./health`).
- **Route layout** (`tests/conventions/routeLayout.unit.test.ts`): folders mirror the URL; each
  `index.ts` is one router and only wires routes; handlers in `controllers.ts`, Zod in `schemas.ts`,
  route-local middleware in `middleware.ts`; every `:param` is mounted from its own singular folder
  (`/sources/:id` → `sources/source/`); register static paths, then `:param` mounts, then `/`.
- **Validation**: always Zod — `validateBody/Params/Query` from `utils/validateReq.ts`, Zod schemas
  for env vars.
- **Errors**: `AppError` subclasses from `utils/errors.ts` — never `res.status(400).json(...)`
  directly. The body is `{ error: <code>, error_description, ...details, request_id }`.
- **Auth**: `authenticate` then `requirePermission()` from `middleware/auth.ts` on every protected
  route. `TEREO_TEST_MODE` (refused in production) accepts the SDK's `test-token-…` tokens; tests
  build them with `tests/support/tokens.ts`. A change that must be audited runs in `withAudit`, and
  nothing calls tereo over the network inside it.
- **Catalogue ids are stable**: grants reference table, column and relation ids, so a refresh
  never deletes a row or changes an id, description or declared relation; what disappears gets
  `missing_since` ([docs/catalog.md](packages/zeteo/docs/catalog.md)). Reading from a source happens
  outside any transaction.
- **Queries**: identifiers in SQL come only from catalogue rows and values are always bound
  parameters; a user query on Postgres runs in `BEGIN TRANSACTION READ ONLY` on its own client; an
  ungranted table or column and a nonexistent one are indistinguishable to a caller
  (`not_found_or_not_accessible`); database error text never reaches a caller
  ([docs/querying.md](packages/zeteo/docs/querying.md)).
- **Migrations**: generated by Prisma (`migrate dev --create-only`), with raw SQL appended only for
  what Prisma cannot express — partial indexes, CHECK constraints.
- **Raw SQL** names tables with their schema (`"core"."core_outbox"`) — there is no `public` schema.
- **Logging**: JSON via Pino, object first (`logger.info({ meta }, "msg")`), with `request_id`
  added during a request. Errors go under `err` (`logger.error({ err }, "msg")`).
- **License**: Apache-2.0 (`LICENSE`, `NOTICE`); every `package.json` says `"license": "Apache-2.0"`.

## Local development

```sh
npm install
docker compose up -d postgres redis                      # host ports 5462 / 6409
docker compose up -d mssql                               # SQL Server for the Azure SQL tests, host port 1463
cp packages/zeteo/.env.example packages/zeteo/.env   # then set ZETEO_MASTER_KEY (generator in the file)
cd packages/zeteo
npx prisma generate && npx prisma migrate deploy
npm run dev                                              # http://localhost:4201
npm run test:unit                                        # no database or Redis needed
npm run test:int                                         # uses <db>_test and Redis db 1 (TEST_DATABASE_URL overrides)
npm run test:local -- --tags-filter "platform"           # a tag expression; npx vitest --list-tags
npx vitest run --project int -t "(azure-sql)"            # one engine's part of the query suite; `(postgres)` for the other
e2e/run.sh                                               # from the root: the end-to-end run against a real Tereo (Docker)
```

`docker compose up` builds the image from source, runs `migrate`, then Zeteo on
http://localhost:4201. `docker/test/run.sh` runs the suite in isolated stacks, one per shard
(`TEST_SHARDS`, default 4), each with its own SQL Server (amd64 only, about 2 GB; emulated on
Apple Silicon). Neither needs a `.env`. The int suite needs SQL Server: `globalSetup` recreates the
`zeteo_fixture` database on it (`TEST_MSSQL_URL` points elsewhere).

## What not to do

- Do not describe planned features as existing in the README, this file or the docs.
- Do not add external API integrations here. They belong in
  [dianemo-plugins](https://github.com/dianemo/dianemo-plugins).
- Do not use `git stash` (shared refs across worktrees have swapped work before).
