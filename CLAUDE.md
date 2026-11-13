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
(`/v1/grants`), and querying (`GET /v1/catalog`, `POST /v1/query`, `GET /v1/runs`). There is no MCP
connection, export or row filter yet. Do not describe or rely on those as existing.

Read [README.md](README.md) first. The design and the plans are in `docs/superpowers/` (kept out of
version control): the design spec is `docs/superpowers/specs/2026-11-12-zeteo-design.md`, and the
plans are beside it in `docs/superpowers/plans/`.

## Layout of `packages/zeteo`

One ordinary package:

| Path | Holds |
|------|-------|
| `src/index.ts` / `app.ts` | Entry point (`createAppServer`, start and graceful stop) and the Express app |
| `src/env.ts` | The one env schema. `src/preload.ts` must be the first import of every entry point |
| `src/definitions/tereoDeclaration.ts` | What zeteo declares to tereo: slug, permissions (`zeteo.sources.read|write`, `zeteo.grants.read|write`, `zeteo.data.read`, `zeteo.data.export`, `zeteo.runs.read`; none organization-assignable, as nothing here is organization-scoped), the `zeteo_admin` and `zeteo_user` roles, audit event names and descriptions. `npm run tereo:provisioning` (in `packages/zeteo`) writes `tereo-provisioning.json` from it; commit both together |
| `src/middleware/auth.ts` | `authenticate` (tereo verifies the token, sets `req.caller`), `callerOf`, `requirePermission` (hierarchical, `utils/permissions.ts`) |
| `src/sources/network.ts` | The one decision whether zeteo may connect to a host: `SOURCE_ALLOWED_HOSTS` rules (`parseAllowedHosts`, parsed at start by `env.ts`) and `resolveAllowed`, which resolves once and returns the address to dial. Link-local, metadata (including Azure's, Alibaba's and Oracle's outside link-local), unspecified and multicast addresses are refused whatever the rules say |
| `src/adapters/` | `SourceAdapter` (settings schema, redaction, connect, login check, schema read, query language, `prepare`, and `openQuery`, a pull-based row stream) per source type, `postgres/` and `azure-sql/`; `adapterFor`. `sql/` is the SQL query language shared by both: `language.ts` (the JSON Schema and parsing), `plan.ts` (the planner over a visible catalogue), `compile.ts` and `dialect.ts` with `dialects/` (the Postgres and SQL Server SQL), `values.ts` (wire forms) |
| `src/sources/` | `service.ts` (create, update, archive, test: the checks, sealing and audit), `pools.ts` (`withSourceConnection`: one pool per source per process, checked against the source's row on every call, retired on a settings change, archive, `source_unreachable` or idle; `stopSourcePools` at shutdown), `connect.ts` (reads settings, `connectChecked`), `network.ts` |
| `src/catalog/` | `refresh.ts` (`refreshSource`: reads the snapshot outside any transaction, then applies it under a per-source advisory lock, batched, in a transaction of up to 120 s; re-reads when the source changed during the read; marks missing, never deletes; `refreshAfterChange` after a create or a settings/schemas change), `relationNames.ts` (naming of discovered relations), `service.ts` (describe a table, declare and remove a relation, each audited) |
| `src/grants/` | `service.ts` (create, replace, remove, read grants, each audited), `access.ts` (`loadAccess`: what a caller's user and groups are granted), `principals.ts` (group membership from tereo, cached 30 s per user) and `principalStatuses.ts`, `visibleCatalog.ts` (`buildVisibleCatalog`/`loadVisibleCatalog`: granted columns only, relations whose keys are all granted; the only view of a source the planner gets) |
| `src/engine/` | `index.ts` (`runQuery`: shape check, plan, concurrency leases, open the run on the adapter and read it, record), `collect.ts` (reads a row stream in batches within the row and byte caps), `export.ts` (`runExport`: the same checks and plan as a query, then export leases, renewed while it runs, and the rows passed to a sink up to the source's export cap; no route uses it yet), `limits.ts` (profiles, row caps, Redis leases: queries 2 per user and 5 per source, exports 1 and 2), `record.ts` (the `query_runs` log; an export's run is `running` until it ends), `errors.ts` |
| `src/jobs/` | `refreshSources.ts`: the check (30-60 s after start, then hourly) that refreshes sources not refreshed in 24 hours, under a Redis lock per source, re-reading each under the lock; started by `index.ts` (not in the test suite's shared server) |
| `src/views/` | Response shapes (`source.ts`, `catalog.ts`, `grant.ts`, `run.ts`, `visibleCatalog.ts`); never carry secrets, and the caller's catalogue view carries no ids |
| `src/routes/` | Mirrors the URL. `index.ts` is the root; `health/` at the root, the API under `v1/` (`sources/`, `sources/source/`, with `archive/`, `test/`, `refresh/`, `tables/` (and `table/`) and `relations/` (and `relation/`); `grants/` (and `grant/`); `catalog/`; `query/`; `runs/`) |
| `openapi/`, `docs/` | The OpenAPI spec (`npm run openapi:lint` / `openapi:build` in `packages/zeteo`) and per-area notes (`docs/sources.md`, `catalog.md`, `grants.md`, `querying.md`, `azure-sql.md`) |
| `src/utils/`, `src/utils/db/` | Shared: `errors.ts`, `cursor.ts`, `crypto/envelope.ts`, `validateReq.ts`, `logger.ts`, `redis.ts`, `requestId.ts`, `httpServer.ts`, `prismaErrors.ts`, `idSchema.ts`, `tereo.ts` (the one SDK client), `transaction.ts` (`withAudit`: a transaction that writes its audit entries to `core.outbox`; optional `timeoutMs`), `outboxCollector.ts`, `text.ts` (`noNul` for request strings); `db/prisma.ts` is the Prisma client and the health probe |
| `src/tests/` | Mirrors `src/`: `<base>[.<aspect>][.unit].test.ts`, `flows/`, `conventions/`; `setup/`, `support/`, `fixtures/` are not tests. Two projects, `unit` (no server) and `int` (one real server). Rules: [src/tests/README.md](packages/zeteo/src/tests/README.md) |
| `prisma/` | The one schema and migrations |

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
  directly. The body is `{ error: <code>, error_description, ...details }`.
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
