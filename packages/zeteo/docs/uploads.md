# Uploads

An upload source is a source whose data Zeteo stores: a person uploads a CSV or an Excel (`.xlsx`) file,
checks and corrects a preview, and gets a source of type `upload` that they own. Its tables live in
Zeteo's own Postgres database, one schema per source (`zu_<id without dashes>`), and are queried
through the same query language, planner, limits, saved queries and exports as any Postgres source,
under grants. A file table never refreshes by itself and changes only when its owner uploads it again.
There is one type of upload source, and its tables can come from different places: each table has an
**origin**, a file, a Google spreadsheet tab (synced on an interval, [Google Sheets](#google-sheets)) or
a merged table (a view over other tables of the source, [Merged tables](#merged-tables)), so one source
can mix them. SharePoint does not exist yet.

Uploads are **off** until `UPLOADS_READER_URL` is set. While it is unset `/v1/uploads`,
`POST /v1/sources` with `type: "upload"` and the upload-only routes on an upload source answer
`404 uploads_not_configured`, and the UI hides the tab.

There is one sources API: an upload source is read, listed, renamed, granted and described through
`/v1/sources` like a database source ([sources.md](sources.md), [catalog.md](catalog.md)), and a
few routes there apply to upload sources only. Only the staging of a file has routes of its own,
`/v1/uploads`.

## Permissions

| Who | Can |
|-----|-----|
| `zeteo.uploads.write` (with `zeteo.data.read`, which an owner always needs) | upload, create upload sources, list their own (`GET /v1/sources?owner_id=me`), and manage, grant and describe the ones they own; not organization-assignable; in `zeteo_admin` |
| `zeteo.sources.read` | list and read every source, upload sources included (`GET /v1/sources`, with `type` and `owner_id` filters) |
| `zeteo.sources.write` | change, transfer and delete any upload source, and change its limits |
| `zeteo.grants.write` | grant on any of them, as on any table |

## The API

| Route | Who | Result |
|-------|-----|--------|
| `POST /v1/uploads` (multipart, field `file`, one file) | `zeteo.uploads.write` | `201 { staging_id, expires_at, tables }`: the preview |
| `DELETE /v1/uploads/:uploadId` | whoever staged it | `204`; the staging's tables are dropped and its place under the cap freed. Anyone else's, an expired or an unknown id is `404 staging_not_found` |
| `POST /v1/sources` `{ type: "upload", staging_id, name, description?, slug?, tables: [{ key, name?, header_row?, columns? }] }` | `zeteo.uploads.write` | `201`, the source |
| `GET /v1/sources?owner_id=me` (also `type=upload`) | the owner, or `zeteo.sources.read` | the caller's own sources |
| `GET`, `PATCH` (`name`, `description`), `DELETE /v1/sources/:id` | the owner, or `zeteo.sources.read` / `.write` | the source; `DELETE` drops its data |
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

The owner is the source's `owner_id`, holding `zeteo.uploads.write` and `zeteo.data.read`.
Anyone who is neither the owner nor holds the admin permission a route needs gets the very `403
forbidden` of a caller without it, whether the source exists or not. On a database source the
upload-only routes (`DELETE`, `transfer`, adding, re-uploading and removing tables, changing a
column) answer `409 not_an_upload_source`; on an upload source the database-only ones (`archive`,
`test`, and `PATCH` with `settings` or `schemas`) answer `409 not_a_database_source`; `refresh` is Sync now there, `409 nothing_to_sync` without Sheets tables.

The reference is `openapi/openapi.yaml`; the SDK has the same calls (`client.sources`, and
`client.uploads.create` and `.discard`).

## The upload flow

1. **Stage.** `POST /v1/uploads` streams the file (never held whole in memory, except an `.xlsx`, see
   below) into a staging table in `zeteo_upload_staging`, a schema the reader role cannot read. The
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
`DELETE /v1/uploads/:uploadId`, which frees its place under `UPLOAD_MAX_STAGINGS`. The housekeeping job
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
| `UPLOADS_READER_URL` | unset (Uploads off) | the reader role's connection URL, below |
| `UPLOAD_MAX_BYTES` | 52428800 (50 MB) | one uploaded file; `413 file_too_large`, with nothing left behind |
| `UPLOAD_MAX_ROWS` | 1000000 | rows per table |
| `UPLOAD_MAX_COLUMNS` | 500 | columns per table |
| `UPLOAD_QUOTA_BYTES` | 1073741824 (1 GB) | stored size across one owner's upload sources; `409 quota_exceeded` |
| `UPLOAD_MAX_STAGINGS` | 5 | unexpired stagings (uploads not yet confirmed) one user holds; `429 too_many_stagings`, whose `retry_after` is when the oldest expires |
| `UPLOAD_MAX_IN_FLIGHT` | 2 | uploads one user has in flight at once, across replicas (a Redis lease, renewed while it runs, given back when the upload ends or is aborted); `429 too_many_uploads` |
| `UPLOAD_XLSX_CONCURRENCY` | 2 | `.xlsx` workbooks one process checks, reads and stages at once; others wait their turn, and one that waits over 30 s is `503 temporarily_unavailable` |

A load that would break a limit fails with its own error and changes nothing. The quota counts
Postgres's stored size of the owner's tables after the load, and is checked under the owner's lock,
so two loads at once cannot both slip under it.

Both upload bounds are checked before the body is read, and the staging count again (under a lock
per user) as the staging is recorded, so concurrent uploads cannot pass it.

An `.xlsx` is a ZIP and is read **fully in memory**. It is refused (`413 file_too_large`, with
`max_bytes` the upload limit and `max_uncompressed_bytes`, and a message about the workbook's
uncompressed content) when its entries declare, or really inflate to, more than
`2 x UPLOAD_MAX_BYTES`; every entry is inflated into a counter before the workbook is read, so
an archive that understates its sizes is caught. No compression ratio is refused as such: a
repetitive workbook may compress very well. Size `UPLOAD_MAX_BYTES` and
`UPLOAD_XLSX_CONCURRENCY` with that in mind for the container's memory.

A CSV cell holding a NUL character (which Postgres text cannot store) is `422 invalid_character`,
naming the row; a NUL in the first 8 KB is refused earlier, as `415 unsupported_file_type`.

## Loading and swapping

Every load (create, add, re-upload, retype) writes a new physical table, then in one transaction
drops the old one, renames the new into place and updates the catalogue. A reader sees the old
table or the new one, never a partial one; a failed load leaves the previous table and catalogue
as they were. Loads of one source are serialized under a Redis lock; one that cannot start or
finish in time is `503 upload_source_busy` (retry shortly), for example while a long query still
reads the table.

### Re-upload

`PUT .../tables/:tableId` goes through the same preview and confirm. Columns are matched by
normalized name: a matched column keeps its id, grants and (editable) type, which the preview may
change; a new column is added and is covered only by `all_columns` grants; a column absent from
the file gets `missing_since`. A column renamed with `PATCH` and then re-uploaded under its old
header comes back as a **new column**, because matching is by name against the table's current
names. A table removed with `DELETE` is dropped and marked missing; its name cannot be added again
to that source. Its measures, and the metrics using them, are deleted with it; a measure of
another table that uses one of them refuses the removal with `409 measure_in_use`
([measures.md](measures.md#changing-measures)).

### Retyping a column

`PATCH` with `type` reloads the table from its stored values (as text) with the new cast; the
column keeps its id and grants. A value that does not cast is `cast_failed` and nothing changes.
Its `rows` are **1-based data rows of the table** (no header; row 1 is the first data row), in the
order of the table's last load, which is the file's order: a value an upload reported as row 3 of
a file with a header is data row 2 here.
Saved queries and dashboards are not checked at retype time: one the new type no longer allows (a
`sum` over a column now `text`) fails when it runs, and for a recipient of a saved query that is the
usual `saved_query_not_accessible`. Measures are not checked either, at a retype, a rename or a
re-upload: a measure the change breaks is kept and shows as broken
([measures.md](measures.md#changing-measures)) until an editor fixes it.

## Owning, granting and sharing

- Creating an upload source gives its owner an `all_columns` user grant on every table (and on tables
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
  on an upload source they own (any other id is `orphaned`), and counts against the search limit.
- **Transfer** moves ownership and the owner flag to a user Tereo knows (not a service account),
  who need not hold `zeteo.uploads.write`. The recipient's quota is checked against the
  source's size (`409 quota_exceeded`). The previous owner keeps an ordinary `all_columns` grant
  unless `keep_access` is `false`.
- **Delete** archives the source and **drops its data at once**: Zeteo holds the only copy. The
  catalogue rows stay, marked missing, so grants and saved queries keep their references and get
  the ordinary no-access behaviour. The owner grants lose their `owner_grant` flag in the same
  transaction, so an admin with `zeteo.grants.write` can remove them like any other grant.
- **Limits** (time limit, row caps, concurrency, whether exports are allowed) are an admin's, as
  for a database source: `PATCH /v1/sources/:id` with `zeteo.sources.write` takes those fields and
  `name` for an upload source (`settings` or `schemas` is `409 not_a_database_source`; an owner
  sending a limit is `403 forbidden`); the admin UI shows a
  Limits dialog on the upload source's page. An upload source starts with exports off.

Changes are audited under the sources' events, with `type: "upload"` in the metadata:
`zeteo.source.created`, `.updated` (a rename or a column change), `.tables_added`,
`.table_reuploaded`, `.table_removed`, `.transferred` and `.deleted`; audit metadata never
carries cell data.

## The reader role (operators)

Queries on upload sources run on a separate Postgres role that can read only the upload source
schemas. This is the safety boundary of the feature, and it is set up by the operator, because
Zeteo's own role cannot create roles. Zeteo needs **Postgres 16 or later**.

The reader lives on **Zeteo's own database**, never another (the data and its catalogue must change
in one transaction). As a role that may create roles, on that database:

```sql
CREATE ROLE zeteo_uploads_reader LOGIN PASSWORD '<secret>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- PUBLIC may create temporary tables by default; the reader must not.
REVOKE TEMP ON DATABASE zeteo FROM PUBLIC;
GRANT TEMP ON DATABASE zeteo TO <zeteo's own role>;
```

then set `UPLOADS_READER_URL=postgresql://zeteo_uploads_reader:<secret>@<host>:5432/zeteo`.
Zeteo's own role needs `CREATE` on the database (it creates the schemas) and grants the reader
`USAGE` on each `zu_*` schema and `SELECT` on its tables. Grant the reader nothing else, and make
it a member of no role. `docker/postgres/uploads-reader.sql` is the local and end-to-end stacks'
version, safe to run again, with a public password for stacks published on 127.0.0.1 only.

**Start-up checks.** Zeteo refuses to start, with a message naming the problem, when the URL's
`sslmode` is not `disable`, `require` or `verify-full`; when its database runs a PostgreSQL older
than 16; when its own role lacks `CREATE` on the database; when the URL's database is not its own;
when the role in the URL is not the connected one; when it is a superuser or bypasses row
security; when it is a member of a role; when it can use or read the `zeteo`, `core` or
`zeteo_upload_staging` schemas; or when it has `TEMP` or `CREATE` on the database. A unix-socket URL
(a `host` query parameter) is not supported: use a TCP host.

Be aware that by default `PUBLIC` holds `CONNECT` on every database of the server, so the reader
can sign in to the others (it still sees nothing there that `PUBLIC` cannot). If another database
holds anything `PUBLIC` can read, `REVOKE CONNECT ON DATABASE <other> FROM PUBLIC` there.

**Turning Uploads off.** With `UPLOADS_READER_URL` unset, `/v1/uploads`, an upload
source's create and its upload-only changes answer `404 uploads_not_configured`, and so does a query, export or MCP query of an `upload`
source that still exists; nothing else changes. Should the URL become unusable at run time (an
unsupported `sslmode`, which start-up refuses), those calls answer `503 uploads_misconfigured`
and the detail is logged.

**Connections.** Each upload source has its own pool of connections against Zeteo's database, sized
like any source's pool (`query_concurrency + export_concurrency + 2` per replica,
[sources.md](sources.md#connection-pools)), so many busy upload sources raise the connections Zeteo's
database holds. Count them against `max_connections`.

## Google Sheets

A table can be backed by one tab of a Google spreadsheet. It needs `zeteo.uploads.write` and, like
file uploads, `UPLOADS_READER_URL` (off while unset). It is made with the plugin
`@dianemo/plugin-google@^2.1.0`, and Zeteo reads sheets with one service account. There is no
Sheets source type: a source of type `upload` gains Sheets tables beside file tables, and each table's
`origin` says which it is (`file`, `google-sheets` with the spreadsheet, tab id and tab title, or
`merged`).

### Setting up Google (admins)

1. Create a Google Cloud project and enable the **Google Sheets API** in it.
2. Create a service account and a JSON key for it.
3. In Zeteo, Admin -> Connections -> Google, paste the JSON key (`PUT /v1/connections/google`,
   `zeteo.sources.write`). The key is sealed; only the service account's email is shown afterwards
   (`GET /v1/connections/google`, which people holding `zeteo.uploads.write` may read too, to know
   whom to share with). The key is checked with Google before it is saved (a probe for a spreadsheet
   that cannot exist): a rejected key is `google_key_rejected`, an unreachable Google
   `google_unavailable`.

A Google Workspace admin setting can block sharing files with addresses outside the domain, and a
service account is outside it. Allow it, or share each sheet explicitly.

Until a key is saved, reading a spreadsheet or syncing is `google_not_configured`.

### Adding a spreadsheet

Share the spreadsheet with the service account's email as **Viewer**. Add data (a new source) and Add
tables (an existing one) take a file or **any spreadsheet link** (`docs.google.com/spreadsheets/d/<id>`
or the bare id; a published-to-web link is refused, `invalid_sheet_link`). `POST /v1/uploads/links`
(`{ url }` to add data, `{ source_id, url }` to add tables) reads it and returns the same preview as a
file: one table per grid tab (chart tabs are skipped), the header row, and each column's name and
type to correct. A sheet not shared with the email is `sheet_not_accessible`, naming the email. A
preview made for another kind of staging is `not_a_file_upload` on a re-upload. Adding a tab that already backs a
table of the source is `tab_already_added`.

**First claim wins, per spreadsheet.** A spreadsheet backs tables in at most one source (`upload_claims`).
A source claims it when it first gains one of its tabs, in the same transaction; another source adding a
tab of it gets `409 sheet_in_use`, without being told who owns it. The claim is released when the source
is deleted or when its last non-removed table of that spreadsheet is removed. A table that is only
missing (its tab was deleted) keeps the claim, since a restored tab revives it; the owner may delete a
table that is missing from a sync to release it. An admin fixes a wrong claim by transferring the source
(the claim moves with it). The risk, stated: someone who has the link and the share and registers first
gets the sheet. Share a sheet only with people who should be able to register it. Known edge: a claim
racing a long swap on the same source can answer `503 upload_source_busy` instead of `409`; a retry gives
the right answer.

### How values load

Zeteo reads Sheets' typed values with their number formats, in the spreadsheet's time zone (UTC when
the sheet has none, or an invalid one).

- Date: `YYYY-MM-DD`. A date-formatted cell that holds a time keeps only the date; the format decides.
- Date time: a UTC instant, with daylight saving applied. A wall time that does not exist resolves
  forward; an ambiguous one takes the earlier instant.
- Time: zero-padded 24-hour text, `HH:MM:SS`. A duration over a day keeps its hours (`30:00:00`).
- A serial outside the years 0001 to 9999 keeps the raw number. Booleans are `true`/`false`; errors
  and empty cells are null.
- Unlike an Excel file, a date time at midnight stays a timestamp: Sheets says which it is.

Every row up to the grid's row count is read, in ranges of 5,000 rows (blank rows in the middle are
fine). A tab's columns are its used width; trailing empty columns are dropped.

**The header row** is suggested by the preview, for files and sheets alike. It also recognises a
label row under a sparse banner (a title above the real header, in the first three rows). A sparse
real header above a full row of text data can be mistaken for a banner: correct `header_row` in the
preview.

### Syncing

A source has one sync interval (`sync_interval_minutes`, 15 to 1440, default 60) for all its Sheets
tables, set when a source is created from a sheet and changed by an admin in the same `PATCH` as the
source's limits; the owner may also set it, on any upload source (`422 not_synced` is for a database source only). The `refreshSources`
job checks every five minutes and syncs a source whose interval has passed since its last attempt
(nothing syncs while uploads are off). **Sync now** is `POST /v1/sources/:sourceId/refresh` (the owner,
or `zeteo.sources.write`), at most once a minute: sooner is `429 sync_too_soon` with `Retry-After`. A
source with no non-removed Sheets table answers `409 nothing_to_sync`. A busy `503 upload_source_busy`
does not use the window and is not recorded as a failed sync. The answer is a `SyncSummary` (`200`)
when at least one table synced or there was nothing to load; when every table failed, the request
fails with the first table's error (for example `422 sheet_not_accessible` or `502 google_unavailable`),
and each table's `sync_error` is still recorded. `tables` lists the tables synced or marked missing in
that run.

**Each Sheets table loads in its own transaction**: one spreadsheet's or tab's failure never holds back
the others, and a failed table keeps its last good data. A source whose Sheets tables are all missing keeps
syncing, so a restored tab revives its table.

- Columns match by header text (`original_name`), then by name, so a column renamed in Zeteo keeps
  syncing. New header columns are added (an `all_columns` grant covers them, a grant on named columns
  does not); a column gone from the header gets `missing_since`.
- Tabs match by sheet id, so renaming or reordering tabs is fine, and the tab title kept in the table's
  origin refreshes on each sync. A deleted tab's table goes missing; restoring the tab revives it with
  its id and grants. A table the owner removed stays removed: a sync never revives it, and its tab can be
  added again (under a new name) as a new table.
- A value that no longer casts to its column's type fails that table (`cast_failed`); the owner retypes
  the column, for instance to text, and syncs again. A tab emptied of rows fails it too (`empty_file`).
  The upload limits (rows, columns, quota) apply, and the limit errors fail a sync as they fail an upload.
- A failed table records `sync_error` on itself (seen by the owner and `zeteo.sources.read` only). The
  source's `sync` is `{ interval_minutes, last_attempt_at, failing, stale }`: `failing` lists the
  failing tables, and `stale` is true when a live Sheets table has failed for 24 hours without a good
  sync (the UI shows **Stale**; a failing source shows a **Sync failing** badge).
- Re-uploading a Sheets table is `not_a_file_upload`; **re-upload is for file tables only**. Its other
  routes (rename, retype, grants, delete) work as for a file; a source's `transfer` moves everything.

Readers see `last_loaded_at` per table in the catalogue and over MCP, never a sync error.

Google is read in requests of about 200,000 cells (100 to 5,000 rows, fewer for a wider tab). The
Google client (dianemo) stops itself on SIGTERM, SIGINT or SIGHUP, before Zeteo has drained its
requests; the next Google call during the drain starts it again, and Zeteo's shutdown stops it last.
A stored key that can no longer be opened (the master key changed) reads as `google_not_configured`:
an admin saves the key again. The key check registers a short-lived client
(`validate-<epoch ms>-<uuid>`); a starting replica removes those left behind more than five minutes
old.

## Merged tables

A merged table stacks two or more tables of one source (file or Sheets tables, any mix) into one, for
data that is split across files or tabs, a sheet per month for instance. It is a live Postgres view in
the source's schema, so it is never loaded or synced itself: it reads its members' current rows.
`origin` is `merged`, and the UI shows "Merged · N tables".

- **Create:** `POST /v1/sources/:sourceId/merged-tables` (the owner, or `zeteo.sources.write`) with
  `{ name, label_column, members: [{ table_id, label }], columns: [{ name, from_name, include }] }`
  (2 to 100 members). **Change:** `PUT /v1/sources/:sourceId/tables/:tableId/merged`, the same body.
  `GET /v1/sources/:sourceId/merged-tables/columns?member=<tableId>&member=...` lists the columns the
  chosen members offer, for the editor.
- **Label column:** a text column added to every row holding its member's label, so rows tell their
  member apart. Labels are suggested from the part of the members' titles that differs (the prefix and
  suffix they share are dropped; a title with nothing left keeps its full title), and are editable (at
  most 100 characters). They are written into the view as escaped SQL literals.
- **Columns:** the union of the members' columns by name, each included or not. The type is fixed when
  the table is saved: members that disagree give `text`. A member lacking a column contributes NULL, and
  so does one whose column no longer casts to the fixed type, with a warning.
- **Live behaviour:** a member that goes missing drops out of the view with a warning and rejoins when
  it is revived. A selected column that no member has any more is marked missing, and comes back with its
  id and grants when a member has it again; columns never selected are listed as available. The row
  count is the sum of the members' rows.
- **Grants:** a merged table has its own grants and catalogue entries, like any table; its creator gets
  an owner grant on create, to the source's owner (also when an admin creates the merged table). Granting a member does not grant the merged table, nor the reverse.
- **Removal:** removing a table that a merged table reads is `409 table_in_merged_table`; change or
  remove the merged table first. A merged table is removed like any table.
- **Rebuilding:** a view is rebuilt only when a change touches its members, so a long read of a merged
  table does not stall unrelated loads.

Error codes: `invalid_sheet_link`, `sheet_in_use`, `sheet_not_accessible`, `google_not_configured`,
`google_key_rejected`, `google_unavailable`, `google_sign_in_failed`,
`tab_already_added`, `not_a_file_upload`, `not_synced`, `sync_too_soon`,
`nothing_to_sync`, `table_in_merged_table`.

## Not supported yet

SharePoint Excel, syncing a file from anywhere, attaching a file to a query on another source,
and locale-aware parsing.

Row rules apply to upload sources like any other: an owner may write them on grants of their own
tables ([row-rules.md](row-rules.md)), without identity values, which only an admin with
`zeteo.grants.write` may use. The owner's own grant never carries one, and a merged table
is its own table: a member's rules do not flow into it.
