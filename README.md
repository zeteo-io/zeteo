# Zeteo

**ζητέω** (*zēteō*) — *to seek.*

zeteo (Greek zēteō, 'to seek') is a query service for apps built on tereo: admins register databases as sources and grant tables and columns to tereo users and groups; people query through a validated JSON query language over HTTP or through an AI connected over MCP.

That is the plan. The repository is at its first step: a scaffold with a service that answers
`GET /health`, now with sign-in through [tereo](https://github.com/tereo-io/tereo). The data model, source
credentials, the Postgres adapter and the admin API are the next steps, in the design spec and its
plans under `docs/superpowers/` (kept out of version control).

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
cp packages/zeteo/.env.example packages/zeteo/.env
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
and changes can write audit entries to tereo's outbox. Nothing else exists yet: no sources, no queries.
