# File Sources

A file source is a source whose data Zeteo stores: a person uploads a CSV or an Excel (`.xlsx`) file,
checks and corrects a preview, and gets a source of type `upload` that they own. Its tables live in
Zeteo's own Postgres database, one schema per source (`zf_<id without dashes>`), and are queried
through the same query language, planner, limits, saved queries and exports as any Postgres source,
under grants. Only uploads exist; a source never refreshes by itself, and changes only when its
owner uploads again. Nothing else (Google Sheets, SharePoint, syncing) exists yet.

File Sources are **off** until `FILE_SOURCES_READER_URL` is set. While it is unset `/v1/uploads`,
`POST /v1/sources` with `type: "upload"` and the upload-only routes on an upload source answer
`404 file_sources_not_configured`, and the UI hides the tab.

There is one sources API: an upload source is read, listed, renamed, granted and described through
`/v1/sources` like a database source ([sources.md](sources.md), [catalog.md](catalog.md)), and a
few routes there apply to upload sources only. Only the staging of a file has routes of its own,
`/v1/uploads`.

## Permissions

| Who | Can |
|-----|-----|
| `zeteo.file_sources.write` (with `zeteo.data.read`, which an owner always needs) | upload, create upload sources, list their own (`GET /v1/sources?owner_id=me`), and manage, grant and describe the ones they own; not organization-assignable; in `zeteo_admin` |
| `zeteo.sources.read` | list and read every source, upload sources included (`GET /v1/sources`, with `type` and `owner_id` filters) |
| `zeteo.sources.write` | change, transfer and delete any upload source, and change its limits |
| `zeteo.grants.write` | grant on any of them, as on any table |

## The API

| Route | Who | Result |
|-------|-----|--------|
| `POST /v1/uploads` (multipart, field `file`, one file) | `zeteo.file_sources.write` | `201 { staging_id, expires_at, tables }`: the preview |
| `DELETE /v1/uploads/:uploadId` | whoever staged it | `204`; the staging's tables are dropped and its place under the cap freed. Anyone else's, an expired or an unknown id is `404 staging_not_found` |
| `POST /v1/sources` `{ type: "upload", staging_id, name, slug?, tables: [{ key, name?, header_row?, columns? }] }` | `zeteo.file_sources.write` | `201`, the source |
| `GET /v1/sources?owner_id=me` (also `type=upload`) | the owner, or `zeteo.sources.read` | the caller's own sources |
| `GET`, `PATCH` (`name`), `DELETE /v1/sources/:id` | the owner, or `zeteo.sources.read` / `.write` | the source; `DELETE` drops its data |
| `POST /v1/sources/:id/transfer` `{ user_id, keep_access? }` | the owner, or `zeteo.sources.write` | transfer ownership |
| `POST /v1/sources/:id/tables` `{ staging_id, tables }` | the owner, or `zeteo.sources.write` | `201`; add tables from a staging |
| `PUT /v1/sources/:id/tables/:tableId` `{ staging_id, key, header_row?, columns? }`, `DELETE` | the owner, or `zeteo.sources.write` | re-upload a table from a staging; remove a table |
| `PATCH /v1/sources/:id/tables/:tableId/columns/:columnId` (`type`, `name`, `description`) | the owner, or `zeteo.sources.write` | change a column |

Each change answers with the source (`DELETE`s with `204`); its tables and columns are read through
`GET /v1/sources/:id/tables` and `…/tables/:tableId`, where an upload source's table carries
`row_count` (the rows loaded) and `last_loaded_at` and its columns `original_name` (`last_loaded_at`
and `original_name` null on a database source, whose `row_count` is the database's estimate at the
last refresh: [catalog.md](catalog.md)).
On an upload source the source's `size_bytes` is what it stores now (0 once deleted, never
measured: `size_measured_at` is null), and `share_count` is how many people and groups its tables
are granted to, the owner grants not counted.

The owner is the source's `owner_id`, holding `zeteo.file_sources.write` and `zeteo.data.read`.
Anyone who is neither the owner nor holds the admin permission a route needs gets the very `403
forbidden` of a caller without it, whether the source exists or not. On a database source the
upload-only routes (`DELETE`, `transfer`, adding, re-uploading and removing tables, changing a
column) answer `409 not_an_upload_source`; on an upload source the database-only ones (`archive`,
`test`, `refresh`, and `PATCH` with `settings` or `schemas`) answer `409 not_a_database_source`.

The reference is `openapi/openapi.yaml`; the SDK has the same calls (`client.sources`, and
`client.uploads.create` and `.discard`).

## The upload flow

1. **Stage.** `POST /v1/uploads` streams the file (never held whole in memory, except an `.xlsx`, see
   below) into a staging table in `zeteo_file_staging`, a schema the reader role cannot read. The
   answer is a preview: one table for a CSV, one per worksheet and per named Excel table for an
   `.xlsx`. Each has its detected header row, a proposed name, row count, parse warnings, and per
   column its normalized name, original header, inferred type and up to 10 sample values. The file
   is judged by its content, not its extension (`415 unsupported_file_type`).
2. **Confirm.** `POST /v1/sources` with `type: "upload"` (or add tables, or re-upload) names the staging and any
   corrections: which tables to keep, table and column names, the header row (a number, or no
   header), column types. Zeteo builds the typed table from staging with SQL casts. A value that
   does not cast fails with `cast_failed` naming the table, column and the first rows (`rows`,
   1-based rows of the file, its header counted, as a spreadsheet numbers them), and nothing is
   created.

A staging belongs to the person who uploaded it, and expires **one hour** after creation (another
person's or an expired id is `404 staging_not_found`); its uploader may discard it sooner with
`DELETE /v1/uploads/:uploadId`, which frees its place under `FILE_SOURCE_MAX_STAGINGS`. The housekeeping job
([retention and housekeeping](querying.md#retention-and-housekeeping)) deletes expired stagings with their tables, and sweeps
staging tables that have no row.

### Parsing rules

- **CSV encodings:** UTF-8 with or without a BOM, and UTF-16 LE or BE with a BOM. Any other
  encoding is `422 unsupported_encoding`.
- **Delimiter:** detected among `,` `;` tab and `|`. Quoting is RFC 4180, with newlines inside
  quotes. A short row is padded with null; a longer row is a parse error naming the row.
- **`.xlsx`:** values, not formulas (a formula's cached value); dates as dates; a merged cell reads
  as its top-left value; empty trailing rows and columns are trimmed. A named Excel table is
  offered beside its sheet.
- **Header row:** detected from the first 1000 rows: row 1 is a header when every cell is
  non-empty text and the column types differ from row 1's. The preview shows the guess; the
  confirm may name another row, or none (columns are then `column_<n>`).
- **Names:** a table or column name is lowercase letters, digits and `_`, starts with a letter and
  is at most 63 bytes; a repeat gets `_2`, `_3`; a blank header is `column_<n>` (1-based). The
  original header is kept as the column's `original_name` and as its first description (editable).
  A table name containing `__load_` is not allowed: it is how Zeteo names a table being loaded.
- **Types:** `text`, `number` (numeric), `boolean`, `date`, `timestamp` (timestamptz); every
  column is nullable and there are no keys. Inference is conservative: `number` only when every
  non-empty value parses and none has a leading zero (so ZIP codes and IDs stay text; `0` and
  `0.5` are numbers); `date` and `timestamp` only ISO 8601; `boolean` only `true`/`false` in any
  case (`yes`/`no` stays text); anything else is `text`. Empty cells are null. Decimal commas
  and other locales are not inferred: the column stays text.

### Limits and environment

| Variable | Default | Limit |
|----------|---------|-------|
| `FILE_SOURCES_READER_URL` | unset (File Sources off) | the reader role's connection URL, below |
| `FILE_SOURCE_MAX_BYTES` | 52428800 (50 MB) | one uploaded file; `413 file_too_large`, with nothing left behind |
| `FILE_SOURCE_MAX_ROWS` | 1000000 | rows per table |
| `FILE_SOURCE_MAX_COLUMNS` | 500 | columns per table |
| `FILE_SOURCE_QUOTA_BYTES` | 1073741824 (1 GB) | stored size across one owner's file sources; `409 quota_exceeded` |
| `FILE_SOURCE_MAX_STAGINGS` | 5 | unexpired stagings (uploads not yet confirmed) one user holds; `429 too_many_stagings`, whose `retry_after` is when the oldest expires |
| `FILE_SOURCE_MAX_UPLOADS` | 2 | uploads one user has in flight at once, across replicas (a Redis lease, renewed while it runs, given back when the upload ends or is aborted); `429 too_many_uploads` |
| `FILE_SOURCE_XLSX_CONCURRENCY` | 2 | `.xlsx` workbooks one process checks, reads and stages at once; others wait their turn, and one that waits over 30 s is `503 temporarily_unavailable` |

A load that would break a limit fails with its own error and changes nothing. The quota counts
Postgres's stored size of the owner's tables after the load, and is checked under the owner's lock,
so two loads at once cannot both slip under it.

Both upload bounds are checked before the body is read, and the staging count again (under a lock
per user) as the staging is recorded, so concurrent uploads cannot pass it.

An `.xlsx` is a ZIP and is read **fully in memory**. It is refused (`413 file_too_large`, with
`max_bytes` the upload limit and `max_uncompressed_bytes`, and a message about the workbook's
uncompressed content) when its entries declare, or really inflate to, more than
`2 x FILE_SOURCE_MAX_BYTES`; every entry is inflated into a counter before the workbook is read, so
an archive that understates its sizes is caught. No compression ratio is refused as such: a
repetitive workbook may compress very well. Size `FILE_SOURCE_MAX_BYTES` and
`FILE_SOURCE_XLSX_CONCURRENCY` with that in mind for the container's memory.

A CSV cell holding a NUL character (which Postgres text cannot store) is `422 invalid_character`,
naming the row; a NUL in the first 8 KB is refused earlier, as `415 unsupported_file_type`.

## Loading and swapping

Every load (create, add, re-upload, retype) writes a new physical table, then in one transaction
drops the old one, renames the new into place and updates the catalogue. A reader sees the old
table or the new one, never a partial one; a failed load leaves the previous table and catalogue
as they were. Loads of one source are serialized under a Redis lock; one that cannot start or
finish in time is `503 file_source_busy` (retry shortly), for example while a long query still
reads the table.

### Re-upload

`PUT .../tables/:tableId` goes through the same preview and confirm. Columns are matched by
normalized name: a matched column keeps its id, grants and (editable) type, which the preview may
change; a new column is added and is covered only by `all_columns` grants; a column absent from
the file gets `missing_since`. A column renamed with `PATCH` and then re-uploaded under its old
header comes back as a **new column**, because matching is by name against the table's current
names. A table removed with `DELETE` is dropped and marked missing; its name cannot be added again
to that source.

### Retyping a column

`PATCH` with `type` reloads the table from its stored values (as text) with the new cast; the
column keeps its id and grants. A value that does not cast is `cast_failed` and nothing changes.
Its `rows` are **1-based data rows of the table** (no header; row 1 is the first data row), in the
order of the table's last load, which is the file's order: a value an upload reported as row 3 of
a file with a header is data row 2 here.
Saved queries and dashboards are not checked at retype time: one the new type no longer allows (a
`sum` over a column now `text`) fails when it runs, and for a recipient of a saved query that is the
usual `saved_query_not_accessible`.

## Owning, granting and sharing

- Creating a file source gives its owner an `all_columns` user grant on every table (and on tables
  added later), flagged `owner_grant`. A grant the owner already had becomes that grant. An owner
  grant, including one an admin made first, cannot be removed or narrowed while it is flagged.
- An owner lists, creates, changes and removes grants on their own tables, and declares and removes
  relations between tables of the source and writes table and column descriptions, with the
  endpoints an admin uses ([grants.md](grants.md), [catalog.md](catalog.md)), and reads the source
  itself at `GET /v1/sources/:sourceId` ([sources.md](sources.md)). Another person's file
  source, or a database source, is `403 forbidden` with no hint the table exists.
- Groups an owner grants to must be global or of their signed-in organization: otherwise `422
  group_not_allowed`. (Saved queries' sharing answers the same rule as `400 invalid_share`.)
- `POST /v1/principals/lookup` is open to an owner but answers only for principals holding a grant
  on a file source they own (any other id is `orphaned`), and counts against the search limit.
- **Transfer** moves ownership and the owner flag to a user Tereo knows (not a service account),
  who need not hold `zeteo.file_sources.write`. The recipient's quota is checked against the
  source's size (`409 quota_exceeded`). The previous owner keeps an ordinary `all_columns` grant
  unless `keep_access` is `false`.
- **Delete** archives the source and **drops its data at once**: Zeteo holds the only copy. The
  catalogue rows stay, marked missing, so grants and saved queries keep their references and get
  the ordinary no-access behaviour. The owner grants lose their `owner_grant` flag in the same
  transaction, so an admin with `zeteo.grants.write` can remove them like any other grant.
- **Limits** (time limit, row caps, concurrency, whether exports are allowed) are an admin's, as
  for a database source: `PATCH /v1/sources/:id` with `zeteo.sources.write` takes those fields and
  `name` for a file source (`settings` or `schemas` is `409 not_a_database_source`; an owner
  sending a limit is `403 forbidden`); the admin UI shows a
  Limits dialog on the file source's page. A file source starts with exports off.

Changes are audited (`zeteo.file_source.created`, `.updated`, `.reuploaded`, `.transferred`,
`.deleted`); audit metadata never carries cell data.

## The reader role (operators)

Queries on file sources run on a separate Postgres role that can read only the file-source
schemas. This is the safety boundary of the feature, and it is set up by the operator, because
Zeteo's own role cannot create roles. Zeteo needs **Postgres 16 or later**.

The reader lives on **Zeteo's own database**, never another (the data and its catalogue must change
in one transaction). As a role that may create roles, on that database:

```sql
CREATE ROLE zeteo_files_reader LOGIN PASSWORD '<secret>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- PUBLIC may create temporary tables by default; the reader must not.
REVOKE TEMP ON DATABASE zeteo FROM PUBLIC;
GRANT TEMP ON DATABASE zeteo TO <zeteo's own role>;
```

then set `FILE_SOURCES_READER_URL=postgresql://zeteo_files_reader:<secret>@<host>:5432/zeteo`.
Zeteo's own role needs `CREATE` on the database (it creates the schemas) and grants the reader
`USAGE` on each `zf_*` schema and `SELECT` on its tables. Grant the reader nothing else, and make
it a member of no role. `docker/postgres/files-reader.sql` is the local and end-to-end stacks'
version, safe to run again, with a public password for stacks published on 127.0.0.1 only.

**Start-up checks.** Zeteo refuses to start, with a message naming the problem, when the URL's
`sslmode` is not `disable`, `require` or `verify-full`; when its database runs a PostgreSQL older
than 16; when its own role lacks `CREATE` on the database; when the URL's database is not its own;
when the role in the URL is not the connected one; when it is a superuser or bypasses row
security; when it is a member of a role; when it can use or read the `zeteo`, `core` or
`zeteo_file_staging` schemas; or when it has `TEMP` or `CREATE` on the database. A unix-socket URL
(a `host` query parameter) is not supported: use a TCP host.

Be aware that by default `PUBLIC` holds `CONNECT` on every database of the server, so the reader
can sign in to the others (it still sees nothing there that `PUBLIC` cannot). If another database
holds anything `PUBLIC` can read, `REVOKE CONNECT ON DATABASE <other> FROM PUBLIC` there.

**Turning File Sources off.** With `FILE_SOURCES_READER_URL` unset, `/v1/uploads`, an upload
source's create and its upload-only changes answer `404 file_sources_not_configured`, and so does a query, export or MCP query of an `upload`
source that still exists; nothing else changes. Should the URL become unusable at run time (an
unsupported `sslmode`, which start-up refuses), those calls answer `503 file_sources_misconfigured`
and the detail is logged.

**Connections.** Each file source has its own pool of connections against Zeteo's database, sized
like any source's pool (`query_concurrency + export_concurrency + 2` per replica,
[sources.md](sources.md#connection-pools)), so many busy file sources raise the connections Zeteo's
database holds. Count them against `max_connections`.

## Not supported yet

Google Sheets, SharePoint Excel, scheduled syncing, attaching a file to a query on another source,
and locale-aware parsing. Row filters on grants do not exist either.
