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
| `POST /v1/sources/:sourceId/test` | `zeteo.sources.write` | `{ ok: true, findings, truncated? }` |
| `POST /v1/sources/:sourceId/refresh` and the `tables` and `relations` routes | see [catalog.md](catalog.md) | |

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

zeteo sends the startup option `default_transaction_read_only=on` as a backstop, and sets
`statement_timeout` for the session. A Postgres source behind an old PgBouncer may refuse the
`options` and `statement_timeout` startup parameters zeteo sends (unless they are listed in its
`ignore_startup_parameters`), and then fails as `source_unreachable`.

### `azure-sql`

```json
{
  "host": "sales.database.windows.net",
  "port": 1433,
  "database": "sales",
  "user": "zeteo_reader",
  "password": "...",
  "tls": "verify"
}
```

`port` defaults to 1433 and `tls` to `verify`; `tls` is `verify` or `trust-server-certificate`, and
the connection is always encrypted. `password` is encrypted at rest and never returned. Sources of
this type are created, checked, read into the catalogue and queried like Postgres sources. The
settings, the read-only login to create, what its login check refuses, the type mapping and how
queries run there are in [azure-sql.md](azure-sql.md).

## Creating and changing

`POST` and a `PATCH` that carries `settings` run, in this order, and store nothing if a step fails:

1. validate `settings` with the type's schema (`400 invalid_request`, issues under `settings.`);
2. check the host against the network rules (`422 host_not_allowed`);
3. connect to the address that passed the check (`502 source_unreachable`);
4. run the login check, then close that temporary connection;
5. refuse a login with findings (`422 writable_login`) unless `allow_writable_login` is true;
6. encrypt the settings and write the row and its audit entry in one transaction.

After a create is committed, Zeteo reads the source's schema into the catalogue
([catalog.md](catalog.md)). If that read fails the source stays, `status` is `unreachable`, and the
answer is still `201`.

A `PATCH` with neither `settings` nor `schemas` never contacts the source; `allow_writable_login`
is accepted only with `settings`, and an override has to be sent again on each settings change. A
settings change closes the source's open pool. After a `PATCH` that carries `settings` or `schemas`
is committed, Zeteo refreshes the catalogue, so it describes the new target at once (and a source
fixed by new settings is `active` again). If that refresh fails the change stands and the answer is
still `200`; `status` becomes `unreachable` only when the refresh failed with `source_unreachable`
or `host_not_allowed`. Any change to an archived source is
`409 source_archived`.

`POST /v1/sources/:sourceId/test` runs steps 2 to 4 against the stored settings on a fresh
connection and returns the findings. It changes nothing.

## The login check and its override

The check runs on every create, on every settings change and on `POST /v1/sources/:sourceId/test`.
It covers the whole connected database, not just the listed `schemas`: the list can change later
without the login being checked again. It reads the catalogs only, counts every role the login is a
member of (it can `SET ROLE` to them), and returns `{ code, detail }` findings for rights a
read-only login would not have. Each code means, for `postgres` (for `azure-sql`, see
[azure-sql.md](azure-sql.md#what-the-login-check-refuses)):

| Code | Meaning |
|------|---------|
| `superuser` | the login, or a role it belongs to, is a superuser (the check stops there and reports only the role attributes) |
| `can_create_roles` | it may create roles |
| `can_create_databases` | it may create databases |
| `bypasses_row_security` | it ignores row-level security policies |
| `owns_objects` | it owns a table, view, schema or the database, so it can change or grant on them |
| `can_write_tables` | it holds INSERT, UPDATE, DELETE or TRUNCATE on a table (also through PUBLIC or a default privilege for tables created later) |
| `can_create_in_schema` | it may create objects in a schema, or schemas in the database |
| `write_role_member` | it belongs to `pg_write_all_data`, `pg_write_server_files`, `pg_execute_server_program`, `pg_maintain`, `pg_signal_backend`, `pg_checkpoint` or `pg_create_subscription` (the detail names the role) |
| `replication` | it has the replication attribute |
| `reads_server_files` | it belongs to `pg_read_server_files` |

**PostgreSQL 14 and older, and databases upgraded from them.** There, every login may create
objects in schema `public` (PUBLIC holds `CREATE` on it). An otherwise read-only login is then
refused with `can_create_in_schema` until the database administrator runs
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`, or the zeteo admin accepts the finding with the
audited `allow_writable_login` override. A database created on PostgreSQL 15 or newer does not
have this grant.

With findings, create and settings change answer `422 writable_login` and the body lists them as
`{ code, detail }` under `findings`: at most 20, with `truncated: true` when there were more.
`POST /v1/sources/:sourceId/test` caps its `findings` the same way. With `allow_writable_login: true` the source is stored with
`writable_login_allowed: true` and the audit entry's metadata carries the codes. With no findings,
`writable_login_allowed` is false whatever the flag says.

Prefer a login that is read-only at the database; the override exists for logins that cannot be
changed.

## Master key

`ZETEO_MASTER_KEY` wraps every source's data key. There is no key-rotation or rewrap command yet.
Starting Zeteo with a different key leaves existing sources unreadable: they still list and view,
with `settings: null`, and using them fails with `500 server_error`, until the original key is
restored. In production the development key published in `docker-compose.yml` is refused.

## Network allowlist

`SOURCE_ALLOWED_HOSTS` (comma separated hostnames, `*.suffix`, IPs and CIDRs; empty means no source
can be added) decides where sources may connect. Link-local, cloud metadata, unspecified and
multicast addresses are refused whatever it says, and so are the platform endpoints outside the
link-local range: `168.63.129.16` (Azure), `100.100.100.200` (Alibaba Cloud) and `192.0.0.192`
(Oracle Cloud). The host is resolved once, checked, and the
connection dials the address that was checked. The check runs again each time a pool is opened.

**A hostname or `*.suffix` rule permits whatever non-refused address that name resolves to,
including loopback and private addresses, so it hands control of the destination to whoever
controls that name's DNS. Prefer address ranges where that matters.**

## Connection pools

Each source has one pool per process (7 connections: the 5 queries a source may run at once, plus
2, so a refresh or login check still gets one; connect timeout 5 s), opened on first use
and closed after 5 idle minutes, on archive, on a settings change and on shutdown. Catalogue reads
(the login check and schema reads) run under a 15 s query timeout; user queries run under the
source's own `timeout_ms` ([querying.md](querying.md)). Concurrent first uses open one pool. A call
running when its pool is closed finishes first.

Every use reads the source's row (one indexed read), so a change made through another replica
reaches this one at its next use: a pool opened with other sealed settings than the row now holds
is closed and a new one opened, and an archived source is refused with `409 source_archived`. Only a
row newer than the pool (by `updated_at`) replaces it: a use whose read landed just before a
settings change runs on the pool already opened with the new settings, and one that finds no pool
(the change just closed it on this replica) reads the row again before opening one. A
use that fails with `source_unreachable` closes the pool, so the next use resolves the host and
connects again (after a database failover to a new address, for example). A use that finds every
connection in use for the connect timeout is `503 temporarily_unavailable` (the source is busy): the
pool is kept, and a refresh that meets it leaves the source's `status` as it was. Once shutdown begins,
no new use is accepted (`503 temporarily_unavailable`), a use whose row read was under way is
refused after it, and shutdown waits up to 2 s for the calls still running (HTTP has already drained
by then). Past that it asks their pools to end and moves on; a call still running is not stopped,
and ends with the process.

## Audit

`zeteo.source.created`, `zeteo.source.updated` and `zeteo.source.archived` are written to the outbox
in the change's transaction. A refresh, a table description change and a relation declared or
removed are audited as well; see [catalog.md](catalog.md). Metadata holds the slug and type, for an update the names of the fields
changed, and for an override the finding codes. A create, and an update that carries `settings`,
also records the settings as the adapter redacts them (for `postgres` and `azure-sql`: `host`,
`port`, `database`, `user` and `tls`), so relaxing TLS or pointing a source elsewhere is on the
record. The password and `ca` are never in an audit entry.

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
| 502 | `source_unreachable` | the source could not be reached or refused the login; the driver's text is logged, never returned |
