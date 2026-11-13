# Zeteo

**ζητέω** (*zēteō*) — *to seek.*

zeteo (Greek zēteō, 'to seek') is a query service for apps built on tereo: admins register databases as sources and grant tables and columns to tereo users and groups; people query through a validated JSON query language over HTTP or through an AI connected over MCP.

The repository has all of it except row filters on grants: a service with sign-in through
[tereo](https://github.com/tereo-io/tereo), the sources admin API (register a Postgres or Azure SQL
database, see [docs/sources.md](packages/zeteo/docs/sources.md)), the catalogue of each source's
tables, columns and relations ([docs/catalog.md](packages/zeteo/docs/catalog.md)), grants
([docs/grants.md](packages/zeteo/docs/grants.md)), and querying: the catalogue of what a caller may
query, the query language, `POST /v1/query` and the run log
([docs/querying.md](packages/zeteo/docs/querying.md)). Azure SQL's particulars are in
[docs/azure-sql.md](packages/zeteo/docs/azure-sql.md). The design spec and its plans are under `docs/superpowers/` (kept out of version
control).

Conventions for contributors and for Claude Code are in [CONTRIBUTING.md](CONTRIBUTING.md) and
[CLAUDE.md](CLAUDE.md).

## Packages

| Path | Contents |
|------|----------|
| `packages/zeteo` | The service: an Express app on port 4201 with Prisma + Postgres and Redis |

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
  `/v1/principal-limits` gives a user or group its own limits on queries and exports at once.
- **Querying.** `GET /v1/catalog` lists what the caller may query, with the query language's JSON
  Schema; `POST /v1/query` runs a validated query, read-only and within limits, with the same
  language and results on both engines; `GET /v1/runs` reads the record of every query.
- **Export.** `POST /v1/export?format=ndjson|csv` streams the result of the same query, up to the
  source's export cap, from sources whose exports are on; gzipped when the client accepts it.
- **MCP.** With `MCP_ALLOWED_CLIENTS` set, `/mcp` serves an AI signed in through tereo four
  read-only tools: `list_sources`, `list_tables` and `describe_table` to discover what it may
  query, and `query`, which runs the same engine as `POST /v1/query` (100 rows by default, at most
  5,000 or 1 MB), with instructions that teach the model the language. A user sees them only with
  `zeteo.mcp.use`, and each needs `zeteo.data.read` too.

Not there yet: row filters on grants.
