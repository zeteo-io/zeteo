# Sources

A source is a database an administrator registers. The admin API is under `/v1/sources` (the
reference is `openapi/openapi.yaml`; `npm run openapi:build` bundles it). Sources are archived,
never deleted.

| Route | Permission | Result |
|-------|------------|--------|
| `POST /v1/sources` | `zeteo.sources.write` | `201`, the source |
| `GET /v1/sources` (`?include_archived=true`, `limit`, `cursor`) | `zeteo.sources.read` | `{ data, next_cursor }` |
| `GET /v1/sources/:sourceId` | `zeteo.sources.read` | the source |
| `PATCH /v1/sources/:sourceId` | `zeteo.sources.write` | the source |
| `POST /v1/sources/:sourceId/archive` | `zeteo.sources.write` | `204` |
| `POST /v1/sources/:sourceId/test` | `zeteo.sources.write` | `{ ok: true, findings }` |

`write` includes `read`. A caller without the permission gets `403 forbidden` before the body is
validated.

## The source

`{ id, slug, name, type, settings, schemas, timeout_ms, row_cap, export_enabled, export_row_cap,
writable_login_allowed, status, last_refreshed_at, created_at, archived_at }`.

- `slug`: `^[a-z][a-z0-9-]{1,62}$`, unique, fixed after create. `type` is fixed too.
- `schemas`: 1 to 20 database schema names Zeteo exposes.
- `settings`: the type's settings without the fields the adapter marks secret. It is `null` for a
  source whose stored settings cannot be decrypted (the master key changed); list and get still
  work, and using the source fails as a `500 server_error` with the generic body.
- Limits: `timeout_ms` 1000 to 120000 (default 30000), `row_cap` 1 to 50000 (default 50000),
  `export_row_cap` 0 to 1000000 (default 0), `export_enabled` (default false).

## Settings per type

### `postgres`

```json
{
  "host": "db.internal",
  "port": 5432,
  "database": "sales",
  "user": "zeteo_ro",
  "password": "...",
  "tls": "verify",
  "ca": "-----BEGIN CERTIFICATE-----..."
}
```

`port` defaults to 5432 and `tls` to `verify`. `tls` is `verify` (certificate checked, against `ca`
when given), `require` (encrypted, certificate not checked) or `off`. Unknown keys are refused.
`password` and `ca` are encrypted at rest and never returned.

zeteo sends the startup option `default_transaction_read_only=on` as a backstop. A Postgres source
behind an old PgBouncer may refuse the `options` startup parameter zeteo sends, and then fails as
`source_unreachable`.

### `azure-sql`

Reserved. Creating one answers `422 source_type_unavailable`.

## Creating and changing

`POST` and a `PATCH` that carries `settings` run, in this order, and store nothing if a step fails:

1. validate `settings` with the type's schema (`400 invalid_request`, issues under `settings.`);
2. check the host against the network rules (`422 host_not_allowed`);
3. connect to the address that passed the check (`502 source_unreachable`);
4. run the login check, then close that temporary connection;
5. refuse a login with findings (`422 writable_login`) unless `allow_writable_login` is true;
6. encrypt the settings and write the row and its audit entry in one transaction.

A `PATCH` without `settings` never contacts the source; `allow_writable_login` is accepted only with
`settings`, and an override has to be sent again on each settings change. A settings change closes
the source's open pool. Any change to an archived source is `409 source_archived`.

`POST /v1/sources/:sourceId/test` runs steps 2 to 4 against the stored settings on a fresh
connection and returns the findings. It changes nothing.

## The login check and its override

The check inspects the login across the whole connected database, not just the listed schemas, and
returns `{ code, detail }` findings for rights a read-only login would not have:
`superuser`, `can_create_roles`, `can_create_databases`, `bypasses_row_security`, `owns_objects`,
`can_write_tables`, `can_create_in_schema`, `write_role_member`, `replication`,
`reads_server_files`.

With findings, create and settings change answer `422 writable_login` and the body lists the codes
under `findings`. With `allow_writable_login: true` the source is stored with
`writable_login_allowed: true` and the audit entry's metadata carries the codes. With no findings,
`writable_login_allowed` is false whatever the flag says.

Prefer a login that is read-only at the database; the override exists for logins that cannot be
changed.

## Network allowlist

`SOURCE_ALLOWED_HOSTS` (comma separated hostnames, `*.suffix`, IPs and CIDRs; empty means no source
can be added) decides where sources may connect. Link-local, cloud metadata, unspecified and
multicast addresses are refused whatever it says. The host is resolved once, checked, and the
connection dials the address that was checked. The check runs again each time a pool is opened.

**A hostname or `*.suffix` rule permits whatever non-refused address that name resolves to,
including loopback and private addresses, so it hands control of the destination to whoever
controls that name's DNS. Prefer address ranges where that matters.**

## Connection pools

Each source has one pool (5 connections, connect timeout 5 s, query timeout 15 s), opened on first
use and closed after 5 idle minutes, on archive, on a settings change and on shutdown. Concurrent
first uses open one pool. A call running when its pool is closed finishes first.

## Audit

`zeteo.source.created`, `zeteo.source.updated` and `zeteo.source.archived` are written to the outbox
in the change's transaction. Metadata holds the slug and type, for an update the names of the fields
changed, and for an override the finding codes. It never holds settings.

## Error codes

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_request` | the body, query or id is invalid |
| 401 / 403 | `unauthorized` / `forbidden` | no valid token / missing permission |
| 404 | `not_found` | no such source |
| 409 | `slug_taken` | the slug exists |
| 409 | `source_archived` | any change to, or test of, an archived source |
| 422 | `host_not_allowed` | the host is not permitted |
| 422 | `writable_login` | the login check found something and the override was not given |
| 422 | `source_type_unavailable` | the type is not available yet |
| 502 | `source_unreachable` | the source could not be reached or refused the login; the driver's text is logged, never returned |
