# Export

`POST /v1/export` runs a query and streams its whole result, up to the source's export cap, as
NDJSON or CSV. It takes the same body as `POST /v1/query` ([querying.md](querying.md)) and is
checked, planned and refused the same way; what differs is how the rows leave, how many may, and
how the run is recorded. The reference is `openapi/openapi.yaml`.

| Route | Permission | Result |
|-------|------------|--------|
| `POST /v1/export?format=ndjson\|csv` | `zeteo.data.export` | `200`, a stream; NDJSON unless `format=csv` |

## Who may export

Three things must all allow it:

- **The permission.** The route needs `zeteo.data.export` (`403 forbidden` without). Of the roles
  zeteo declares only `zeteo_admin` carries it; give it to others through a role of the deploy's
  own in Tereo.
- **The source.** Its `export_enabled` must be true and its `export_row_cap` above 0
  ([sources.md](sources.md#the-source)); otherwise `403 export_not_enabled`. `GET /v1/catalog`
  shows both under `limits.export` (`{ enabled, max_rows }`).
- **The grants.** An export sees exactly what a query sees: the caller's own and their groups'
  grants ([grants.md](grants.md)). An ungranted source, table, relation or column is refused as one
  that does not exist (`422 not_found_or_not_accessible`), before any byte of the stream.

## The request

`?format=` is `ndjson` (the default) or `csv`; any other value, or any other query parameter, is
`400 invalid_request`. The body is a query in the source's language, at most 64 KB.

Everything refused before the stream starts (its head: the status line, the headers and, in
NDJSON, the first line) is an ordinary JSON error response with the codes of
`POST /v1/query`, plus `403 export_not_enabled`, `429 too_many_exports` and `422 invalid_order` at
path `["offset"]` (below). Once the status line has been sent no error body can follow: a failure
after that cuts the connection (see *How a stream ends*).

### Order

**An export has no default order.** A query without `orderBy` is sorted by every select item so
its pages are stable; an export is not, so the source can send its first row without sorting the
whole result first. Without `orderBy`:

- rows come in whatever order the source makes them, which may differ from one run to the next;
- an export stopped at its cap is an arbitrary subset of the result, not its first rows;
- `offset` above 0 is refused, `422 invalid_order` at path `["offset"]`, since it would skip
  arbitrary rows.

Give an `orderBy` only when the order matters, and order by a key (a primary key, or columns that
are unique together): sorting a large result by something else holds back the first row until the
source has sorted it all, and a sort that is not unique still leaves ties in no set order.

## The stream

Headers, for both formats:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/x-ndjson` or `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="zeteo-export-<run id>.ndjson"` (or `.csv`) |
| `X-Zeteo-Run-Id` | the run's id in the run log |
| `Cache-Control` | `no-store` |
| `Vary` | `Accept-Encoding` |
| `Content-Encoding` | `gzip` when the request's `Accept-Encoding` accepts gzip (`gzip`, or `*`, with a q above 0); absent otherwise |
| `Trailer` | CSV only: `X-Zeteo-Export-Status, X-Zeteo-Export-Rows` |
| `X-Zeteo-Warnings` | CSV only, when the query has warnings: their codes, comma separated |

The status and headers are sent once the source has started the result: on Postgres once its first
row has been read (or the result is known to be empty), so a query slow to make its first row holds
them back; on Azure SQL once the result's columns are known. Rows are read in
batches sized by bytes, as a query's are: one row first, then as many rows of the average width so
far as fit about 1 MB, at most 250. Each batch is written in chunks of about 64 KB, and each chunk
waits until the client has taken the last, so a slow client slows the export rather than filling
memory, however wide its rows.

### NDJSON

One JSON value per line, each ending in `\n`:

```
{"columns":[{"name":"id","type":"number"},{"name":"status","type":"text"}],"warnings":[],"run_id":"0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a"}
[1,"paid"]
[2,"paid"]
{"status":"complete","rows":2}
```

The first line is the head: the columns, the query's warnings and the run's id. Each row is an
array of values in the order of `columns`, in the same wire forms as `POST /v1/query`'s rows
([querying.md](querying.md#results)). The last line is the tail.

### CSV

RFC 4180, UTF-8, CRLF line ends: a header record of the column names, then one record per row. A
field holding `"`, `,`, CR or LF is quoted, with `"` doubled.

- A null is an empty field; an empty string is `""`, so the two read back apart.
- Numbers, booleans, dates and timestamps are written as their wire forms (64-bit integers and
  decimals with all their digits). A json value is written as its JSON text.
- **The formula guard.** A text, json or `other` cell that starts with `=`, `+`, `-`, `@`, tab or CR is
  written with a leading `'`, so a spreadsheet reads it as text instead of running it as a
  formula. Numbers, dates and timestamps are never guarded (`-42` stays `-42`). CSV text is
  therefore not byte-exact: a value that started with one of those characters comes back with a
  `'` in front. NDJSON is byte-exact.

The tail travels as HTTP trailers after the last record: `X-Zeteo-Export-Status` and
`X-Zeteo-Export-Rows`.

## How a stream ends

| End | NDJSON | CSV |
|-----|--------|-----|
| Complete: every row of the result was sent | last line `{"status":"complete","rows":n}` | trailers `complete`, `n` |
| Truncated: more rows existed than the cap, the first `n` sent were all that may be | last line `{"status":"truncated","rows":n}` | trailers `truncated`, `n` |
| Cut: the export failed, timed out, or the service stopped mid-stream | no last line; the connection is cut without its final chunk | no trailers; the connection is cut without its final chunk |

The cap is the source's `export_row_cap`, or the query's `limit` when that is lower.

**Verify completeness with NDJSON.** A stream that ends without its tail line did not end; one
with `"status":"complete"` sent every row. CSV's trailers say the same, but trailers are invisible
to browsers' `fetch` and to a download, an HTTP/1.0 client gets none (there, a cut connection and
a finished one look alike), and a proxy may drop them. When completeness matters, use NDJSON, or
check the run's `outcome`, `row_count` and `truncated` with `GET /v1/runs` afterwards.

A client that disconnects stops the export: the query is cancelled on the source and the run is
recorded `failed` with `client_closed`.

## Limits

- **Rows.** Up to the source's `export_row_cap` (at most 1,000,000), lowered by the query's
  `limit`. There is no byte cap.
- **Time.** 10 minutes from the start to the last row, time spent waiting on a slow client
  included; the source's own `timeout_ms` does not apply. Past it the query is cancelled on the
  source and the stream cut (recorded `timeout`, `query_timeout`); one that runs out before the
  stream starts (its head) is an ordinary `504 query_timeout`. On Postgres an export reads inside
  one transaction, idle between fetches while its client is slow, so a source's
  `idle_in_transaction_session_timeout` cuts an export whose reader is slower than it.
- **Concurrency.** Counted in Redis across replicas, apart from queries: per user
  `USER_EXPORT_CONCURRENCY` at once (1 to 10, default 1), unless the user or one of their groups
  has its own limit ([grants.md](grants.md#concurrency-limits)), one more being
  `429 too_many_exports`; per source its `export_concurrency` (1 to 10, default 2), one more being
  `429 source_busy`. Both carry `Retry-After` and `retry_after`. An export holds its two slots for
  30 seconds at a time and renews them every 10 seconds while it runs, so the slots of an export
  whose process died free themselves within 30 seconds. A renewal Redis does not take is logged
  and the export goes on; if Redis stays away past 30 seconds its slots lapse and the limits are
  not enforced against it until it ends. When Redis fails or does not answer within a second as
  the export starts, it is `503 temporarily_unavailable`.

## What is recorded

An export goes in the run log ([querying.md](querying.md#the-run-log)) with entry point `export`,
and never with any of its rows.

- **Refused before it starts** (any `4xx`, or a failure before the stream starts, its head): one `query_runs`
  row and one `zeteo.export.run` audit entry (verb `CREATE`), exactly as a refused query.
- **Started**: just before its head is sent, a row with outcome `running` and a
  `zeteo.export.started` entry (`{ source_id, entry_point }`), in one transaction. When it ends
  the row is closed and a `zeteo.export.run` entry (verb `UPDATE`) written, with `{ source_id,
  entry_point, outcome, error_code, row_count, duration_ms }`:

  | How it ended | `outcome` | `error_code` | `row_count` | `truncated` |
  |--------------|-----------|--------------|-------------|-------------|
  | complete | `ok` | null | rows sent | false |
  | truncated | `ok` | null | rows sent | true |
  | client went away | `failed` | `client_closed` | rows sent | false |
  | 10-minute limit | `timeout` | `query_timeout` | rows sent | false |
  | shutdown | `failed` | `shutting_down` | rows sent | false |
  | any other failure | `failed` | its code | rows sent | false |
  | its process died | `failed` | `interrupted` | null | false |

  An export is recorded `ok` only once the client has taken its end.

So a started export always has two audit entries, and a run left `running` by a crash still says
who exported what from which source. The housekeeping job closes such a run as `failed` with
`interrupted` once it is 15 minutes old (the 10-minute limit and a margin), with its own
`zeteo.export.run` entry; see [querying.md](querying.md#retention-and-housekeeping). When an
export's end cannot be written (zeteo's own database briefly away), it is tried three more times
over about five seconds, after the client has had its end and without holding up the stream; each
failure is logged, and a run still not closed is left for the job.

## Shutdown

On `SIGTERM` every running export is stopped at once, before the HTTP drain (a 10-minute stream
cannot fit a 25-second drain): its query is cancelled, its stream cut, and its run recorded `failed`
with `shutting_down`. An export that arrives after that is refused with
`503 temporarily_unavailable` and not recorded. Clients retry an export cut by a deploy.

## Load and read replicas

An export reads up to a million rows in one statement and may hold it open for ten minutes. A
source's pool is sized for its queries and its exports together (each replica opens up to
`query_concurrency + export_concurrency + 2` connections per source,
[sources.md](sources.md#connection-pools)), so exports running at their limit do not leave
queries without a connection, but they still load the database.

Point a source that will be exported from at a read replica or a copy rather than the primary:
register the replica's host as its own source. On Postgres a hot standby works; a long export
there can be cancelled by replication conflicts unless the standby allows for it
(`max_standby_streaming_delay`, `hot_standby_feedback`), and is then cut like any failed export.
On Azure SQL use a readable secondary that has its own hostname; read scale-out reached with
`ApplicationIntent=ReadOnly` is not supported ([azure-sql.md](azure-sql.md#exports-and-load)).

## Error codes

Beyond those of `POST /v1/query` ([querying.md](querying.md#errors)):

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_request` | an unknown `format` or query parameter, or a body the language refuses |
| 403 | `forbidden` | no `zeteo.data.export` |
| 403 | `export_not_enabled` | the source's exports are off, or its `export_row_cap` is 0 |
| 422 | `invalid_order` | `offset` above 0 without `orderBy`, at path `["offset"]` |
| 429 | `too_many_exports` / `source_busy` | the user's or the source's export limit is reached |
| 503 | `temporarily_unavailable` | Redis, group membership or the source briefly unavailable, or the service is shutting down |
| 504 | `query_timeout` | the 10 minutes ran out before the stream started (its head) |
