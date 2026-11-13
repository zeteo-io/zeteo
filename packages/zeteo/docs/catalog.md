# Catalogue

The catalogue is what Zeteo knows about a source's tables, columns and the relations between tables.
It is read from the source by a refresh and described by an administrator. Grants
([grants.md](grants.md)) refer to its tables and columns by id and queries
([querying.md](querying.md)) run over the part a caller is granted, so **ids are stable**: a refresh
never changes the id of a table, column or relation.

| Route | Permission | Result |
|-------|------------|--------|
| `POST /v1/sources/:sourceId/refresh` | `zeteo.sources.write` | the refresh summary |
| `GET /v1/sources/:sourceId/tables` (`?include_missing=true`, `limit`, `cursor`) | `zeteo.sources.read` | `{ data, next_cursor }`, in schema and name order |
| `GET /v1/sources/:sourceId/tables/:tableId` | `zeteo.sources.read` | the table with its columns and its relations |
| `PATCH /v1/sources/:sourceId/tables/:tableId` | `zeteo.sources.write` | the table view |
| `GET /v1/sources/:sourceId/relations` (`limit`, `cursor`) | `zeteo.sources.read` | `{ data, next_cursor }`, in creation order |
| `POST /v1/sources/:sourceId/relations` | `zeteo.sources.write` | `201`, the relation |
| `DELETE /v1/sources/:sourceId/relations/:relationId` | `zeteo.sources.write` | `204` |

A table or relation id from another source is `404 not_found` through this source's URL. Every
change to an archived source is `409 source_archived`; reads still work.

## Refresh

A refresh reads the source's tables, views, columns and foreign keys in its `schemas` (what the
login can select) and writes them to the catalogue in one transaction. A table or view is listed
only when the login holds `SELECT` on the whole of it; one it can read only through column-level
`SELECT` grants is not listed. It runs

- after `POST /v1/sources`, and after a `PATCH` that changes `settings` or `schemas` (a failure
  there leaves the source with `status: unreachable`; the create or change stands),
- on `POST /v1/sources/:sourceId/refresh`,
- from a job that checks every hour and refreshes each unarchived source not refreshed in the last
  24 hours (including sources never refreshed and ones marked `unreachable`), one at a time, under
  a Redis lock `zeteo:refresh:<sourceId>` with a 15 minute expiry so replicas do not repeat the
  work. Having taken the lock, the job reads the source again and skips it if another replica
  refreshed it, or it was archived, since the list was read. A failing source is logged and the
  job goes on. The first check comes 30 to 60 seconds after start (a random delay, so replicas
  started together spread out), then one every hour.

The summary is `{ tables: { added, missing, restored }, columns: { added, changed, missing,
restored }, relations: { added, missing, restored } }`. `missing` counts things newly marked
missing in this refresh.

**A refresh changes:**

- adds tables, columns and discovered relations that are new;
- marks a table, column or discovered relation that is no longer in the source (a relation also
  goes missing when either of its tables or columns does) with `missing_since`
  (set once; later refreshes keep the first value), and clears it when the thing returns;
- updates a column in place when its normalised type, native type, nullability or primary-key flag
  changed (counted as `changed`), and its position;
- updates a table's `kind` (table or view), `last_seen_at`, and the columns or target of a
  discovered relation whose foreign key changed under the same constraint name;
- sets the source's `status` to `active` and `last_refreshed_at`; a refresh that cannot read the
  source sets `status` to `unreachable`, throws `502 source_unreachable` and changes nothing else.

**A refresh never:** deletes a row, changes an id, changes a description, or touches a declared
relation. The columns of a table that disappears are marked missing with it.

Column types are normalised to `text`, `number`, `boolean`, `date`, `timestamp`, `json` or `other`;
`native_type` keeps the database's own name. On Postgres it also says what the name cannot: an
enum is `<name> (enum)` and a domain `<name> (domain over <base type>)`, such as
`sales.price (domain over money)`; the query engine reads a domain as its base type.

### Concurrent refreshes

The write takes `pg_advisory_xact_lock` keyed on the source, so refreshes of one source apply one
after another, and a second never fails with a unique violation. The snapshot is read before the
lock (no database connection is held while the source answers). A snapshot read before another
refresh finished could be the older of the two, and one read before the source's `settings` or
`schemas` changed describes the old target, so after taking the lock the write checks that the
source's `last_refreshed_at` and `updated_at` are still what they were before the read; if not, it
reads again (at most five reads; the fifth is applied). The catalogue therefore ends matching the
newest read of the current settings. A wait for the lock longer than `DB_LOCK_TIMEOUT_MS` answers
`503 temporarily_unavailable`. The write may run for up to 120 seconds, longer than an ordinary
change (`DB_TRANSACTION_TIMEOUT_MS`), so a source with thousands of tables can be refreshed.
Declaring and removing a relation take the same lock, so while a long refresh holds it they wait
`DB_LOCK_TIMEOUT_MS` and then answer `503 temporarily_unavailable`; retry them.

## Descriptions

`PATCH` takes `{ description?, columns?: [{ name, description }] }` (at least one; `null` clears a
description; each at most 2000 characters, `400 invalid_request` beyond that or for a column the
table does not have). What the body leaves out is unchanged. It is audited as
`zeteo.source.updated` with the table and what changed.

## Relations

Each foreign key gives two **discovered** relations, matched across refreshes by constraint name:

- forward, on the table that holds the key, `to_many: false`, named after the single key column
  without a trailing `_id`, `Id` or `_fk` (`customer_id` gives `customer`), or the target table's
  name when the key has several columns or nothing is left of the column's name (`id`);
- reverse, on the referenced table, `to_many: true`, named after the table that holds the key.

Discovered names follow the declared-name pattern: camelCase boundaries become `_`, the name is
lower-cased, other characters become `_`, a name not starting with a letter gets `r_` in front, an
empty one is `relation`, and it is cut so that a `_N` suffix still fits in 63 characters. Names
already stored are never renamed.

When a name is already taken on that table (by another relation, discovered or declared) a `_2`,
`_3`, ... is appended. A discovered relation keeps its name and id when its foreign key is dropped
and created again, even under another constraint name (a missing or renamed relation with the same
tables, columns and direction is taken over; exact constraint names are matched first), and cannot
be removed (`409 relation_discovered`).

A **declared** relation is one an administrator adds, for a join the database does not enforce:

```json
{ "name": "by_region", "from_table_id": "...", "from_columns": ["region"],
  "to_table_id": "...", "to_columns": ["region"], "to_many": true }
```

`name` matches `^[a-z][a-z0-9_]{0,62}$` and is unique on the from table (`409 relation_name_taken`).
It is refused with `422 invalid_relation` when a table is not in this source, a column does not
exist or is marked missing, the column lists differ in length or repeat a column, or paired
columns have different normalised types or have type `other` or `json`. `origin` is `declared`.
Declaring and removing are audited as `zeteo.relation.declared` and `zeteo.relation.removed`
(entity type `relation`, with `source_id` in the metadata).

## Error codes

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_request` | a body, query, cursor or id is invalid |
| 404 | `not_found` | no such source, table or relation (also another source's) |
| 409 | `source_archived` | any change to an archived source |
| 409 | `relation_name_taken` | the from table already has a relation of that name |
| 409 | `relation_discovered` | removing a discovered relation |
| 422 | `invalid_relation` | the declared relation fails a check above |
| 422 | `host_not_allowed` | a refresh found the source's host no longer permitted by the network rules |
| 502 | `source_unreachable` | a refresh could not read the source |
| 503 | `temporarily_unavailable` | the database was busy, or a declare or remove waited too long for a refresh's lock |
