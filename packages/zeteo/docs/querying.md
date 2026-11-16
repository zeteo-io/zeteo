# Querying

Users query sources through one JSON language, over only the tables and columns they are granted
(see [grants.md](grants.md)), over HTTP or through an AI connected over MCP ([mcp.md](mcp.md)). The
same query can be exported whole as NDJSON or CSV ([export.md](export.md)). The reference for the
routes is `openapi/openapi.yaml`.

| Route | Permission | Result |
|-------|------------|--------|
| `GET /v1/catalog` (`source`) | `zeteo.data.read` | `{ sources }`: what the caller may query, and the language schema |
| `POST /v1/query` | `zeteo.data.read` | `{ columns, rows, truncated, truncated_by?, warnings, run_id }` |
| `POST /v1/export` (`format`) | `zeteo.data.export` | a stream of NDJSON or CSV ([export.md](export.md)) |
| `GET /v1/runs` (`user_id`, `source_id`, `outcome`, `limit`, `cursor`) | `zeteo.runs.read` | `{ data, next_cursor }`, newest first |

## The SQL query language

Every SQL source, Postgres and Azure SQL alike, takes the same language and returns the same
results for the same data:

```json
{
  "source": "sales-db",
  "from": "orders",
  "join": ["customers", { "relation": "order_lines", "type": "left" }],
  "select": [
    "customers.region",
    { "bucket": "month", "column": "created_at", "as": "month" },
    { "sum": "total", "as": "revenue" }
  ],
  "where": { "status": { "in": ["paid", "shipped"] } },
  "groupBy": ["customers.region", "month"],
  "having": { "revenue": { "gt": 1000 } },
  "orderBy": [{ "revenue": "desc" }],
  "limit": 1000,
  "offset": 0
}
```

- **`source`** is the source's slug.
- **`from`** names a table or view by its bare name when that is unique among the source's
  schemas, otherwise `schema.table`.
- **Columns** are paths: a bare name is a column of the `from` table; `relation.column` is a column
  of a joined table, and `customers.accounts.plan` one reached through two relations.
- **`join`** lists relations by name (see `docs/catalog.md`), `inner` by default or
  `{ "relation": "...", "type": "left" }`. A relation reached through another is joined after it:
  `["customers", "customers.accounts"]`. At most the source's `max_joins` joins (4 unless the source sets more, up to 8; a query over the source's limit is `422 too_many_joins`). A relation can be used only when every key
  column on both sides is granted.
- **`select`** holds 1 to 50 items: column paths; aggregates `{ "count": path | "*" }`,
  `{ "countDistinct": path }`, `{ "sum": path }`, `{ "avg": path }`, `{ "min": path }`,
  `{ "max": path }`; date buckets `{ "bucket": "day" | "week" | "month" | "quarter" | "year",
  "column": path }`, truncated in UTC, weeks starting on Monday. Each takes an optional `"as"`
  (a lowercase letter, then up to 62 of `a-z`, `0-9`, `_`). Without one an item is named by its
  path, or `count`, `sum_total`, `bucket` items `month_created_at`, and so on. A calculation
  (`{ "calc": expression, "as": name }`) and an aggregate over an expression always need one
  (see *Calculations*).
- **`distinct: true`** returns each row once.
- **`where`** is a filter (below) over columns.
- **`groupBy`** names select items, by output name or by column path. A query with an aggregate
  groups by every other select item, and every non-aggregate item must be listed.
- **`having`** is a filter over the output names of aggregate select items.
- **`orderBy`** is a list of `{ "<name>": "asc" | "desc" }`, each a select item or, in a query
  that is neither grouped nor distinct, any granted column. Nulls sort last ascending and first
  descending, on every engine. Without `orderBy`, rows are ordered by every select item ascending
  (json items aside), so paging with `offset` is stable. An export (`POST /v1/export`) has no
  such default: without `orderBy` its rows come in whatever order the source makes them, so the
  first is sent without waiting for the source to sort them all, and an export with an `offset`
  above 0 and no `orderBy` is refused (`422 invalid_order` at path `["offset"]`).
- **`limit`** (default 1,000) and **`offset`** (at most 1,000,000) page the result.

Every object is strict: an unknown key is refused. Expressions are the closed set of operations
under *Calculations*; there are no other function calls, subqueries or raw fragments.

## Calculations

An **expression** is a column path (`"unitprice"`, `"product.name"`), a number, a text literal
`{ "value": "text" }` (a bare string is a path), an aggregate, or an object with exactly one
operation key:

| Operation | Operands | Result |
|---|---|---|
| `add`, `mul` | array of 2 to 10 numbers | number |
| `sub`, `div` | array of exactly 2 numbers | number; `div` by zero gives null and never truncates |
| `abs` | one number | number |
| `round` | `[number, places]` (places an integer literal, 0 to 10), or one number (0 places) | number; half away from zero on both databases |
| `concat` | array of 2 to 10 text or number expressions | text; null counts as empty text |
| `lower`, `upper` | one text | text |
| `coalesce` | array of 2 to 10 expressions of one type | that type; the first non-null |

Aggregates (`sum`, `avg`, `min`, `max` over an expression; `count`, `countDistinct` over a path)
may sit inside operations, and an aggregate may not contain another aggregate. `bucket` still
takes a column path only.

**Where calculations go**

- A select item: `{ "calc": expression, "as": "name" }`; `as` is required.
- An aggregate's argument: `{ "sum": { "mul": ["unitprice", "orderqty"] }, "as": "revenue" }`.
  `sum`, `avg`, `min` and `max` take an expression where they took a path, and then need `as`;
  `count` and `countDistinct` stay paths.
- By name elsewhere: a calculation's `as` works in `groupBy` and `orderBy`, in `having` when it
  is group-level, and in `where` when it is row-level (zeteo puts the calculation itself into the
  WHERE clause, since SQL cannot name a select alias there). A `where` key is read as a select
  name first, then as a column path; a name that is both is `422 duplicate_output_name`: pick
  another `as`.

**Row-level and group-level**

- A calculation with no aggregate is **row-level**: computed per row, it behaves like a column. In
  a grouped query it must be listed in `groupBy`.
- A calculation in which **every column sits inside an aggregate** is **group-level**
  (`{ "div": [{ "sum": "unit_cost" }, { "sum": "unit_price" }] }`): it behaves like an aggregate, needs
  no `groupBy` entry, and can be named in `having` and `orderBy`, never in `where` (`422
  invalid_grouping`). Literals may appear outside the aggregates.
- A calculation that mixes the two (a bare column beside an aggregate) is refused with
  `422 invalid_grouping`, at the bare column.

**Types.** Arithmetic takes `number` columns, `lower` and `upper` take `text`; `concat` takes text
or numbers (numbers are converted to text). Dates, booleans, json and `other` columns are refused
with `422 invalid_operator`, at the path of the operand (`select.2.sum.mul.1`). `coalesce` operands
must share one type. Every column an expression reads goes through the usual column resolution, so
grants, joins and `not_found_or_not_accessible` work as for a plain path, and the run record lists
the columns read. A result is typed in `columns` like any select item; decimals arrive as strings.

**Precision.** Both databases give the same value, not necessarily the same digits after the
point. `div` is a decimal division that keeps at least 6 decimal places (the most SQL Server
guarantees); wrap it in `round` to get exactly the places you want, which is also the way to
identical text on both. Integer `add`, `sub` and `mul` can overflow, which is `502 query_failed`.
Literals are bound parameters and count towards the parameter limit.

**Limits.** An expression nests at most 5 levels (an aggregate counts as one), a query holds at
most 100 operation and aggregate objects in all, `add`, `mul`, `concat` and `coalesce` take 2 to
10 operands, and `round` places are 0 to 10.

The examples below use one small schema, with relation names as the discovery rules give them (a
single key is named after its target table):

- `orders` (id, customer_id, status, created_at); relation `customers`
- `order_lines` (id, order_id, product_id, unit_price, quantity, discount, unit_cost); relations
  `orders` and `products`
- `products` (id, name, category)
- `customers` (id, first_name, last_name, email)

Value of each order line (row-level); `line_value` is not a column, so `where` can name it:

```json
{
  "source": "sales-db",
  "from": "order_lines",
  "select": [
    "id",
    { "calc": { "mul": ["unit_price", "quantity"] }, "as": "line_value" }
  ],
  "where": { "line_value": { "gt": 1000 } }
}
```

Margin by product category (group-level): revenue and cost are computed from the lines, and the
ratio is rounded to three places. `mul` by 100 for a percentage would nest one level past the limit
of 5, so the result is a fraction:

```json
{
  "source": "sales-db",
  "from": "order_lines",
  "join": ["products"],
  "select": [
    "products.category",
    {
      "calc": {
        "round": [
          {
            "div": [
              {
                "sub": [
                  { "sum": { "mul": ["unit_price", "quantity"] } },
                  { "sum": { "mul": ["unit_cost", "quantity"] } }
                ]
              },
              { "sum": { "mul": ["unit_price", "quantity"] } }
            ]
          },
          3
        ]
      },
      "as": "margin"
    }
  ],
  "groupBy": ["products.category"],
  "orderBy": [{ "margin": "desc" }]
}
```

Average order value, each order counted once however many lines it has:

```json
{
  "source": "sales-db",
  "from": "order_lines",
  "select": [
    {
      "calc": {
        "div": [
          { "sum": { "mul": ["unit_price", "quantity"] } },
          { "countDistinct": "order_id" }
        ]
      },
      "as": "average_order_value"
    }
  ]
}
```

Full name (row-level); a null last name counts as empty text:

```json
{
  "source": "sales-db",
  "from": "customers",
  "select": [
    "id",
    {
      "calc": { "concat": ["first_name", { "value": " " }, "last_name"] },
      "as": "full_name"
    }
  ]
}
```

## Worked examples

Revenue per region and quarter, paid orders only:

```json
{
  "source": "sales-db",
  "from": "orders",
  "join": ["customers"],
  "select": [
    "customers.region",
    { "bucket": "quarter", "column": "created_at", "as": "quarter" },
    { "sum": "total", "as": "revenue" },
    { "count": "*", "as": "orders" }
  ],
  "where": { "status": { "eq": "paid" } },
  "groupBy": ["customers.region", "quarter"]
}
```

```json
{
  "columns": [
    { "name": "customers.region", "type": "text" },
    { "name": "quarter", "type": "timestamp" },
    { "name": "revenue", "type": "number" },
    { "name": "orders", "type": "number" }
  ],
  "rows": [
    ["EU", "2026-01-01T00:00:00.000Z", "1535.50", "4"],
    ["EU", "2026-04-01T00:00:00.000Z", "1409.99", "2"],
    ["US", "2026-04-01T00:00:00.000Z", "640.10", "1"]
  ],
  "truncated": false,
  "warnings": [],
  "run_id": "0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a"
}
```

Customers whose name mentions "organic", with no email on file:

```json
{
  "source": "sales-db",
  "from": "customers",
  "select": ["id", "name"],
  "where": {
    "and": [{ "name": { "contains": "organic" } }, { "email": { "isNull": true } }]
  }
}
```

The ten most recent orders over 100, and the next ten:

```json
{
  "source": "sales-db",
  "from": "orders",
  "select": ["id", "total", "created_at"],
  "where": { "total": { "gt": 100 } },
  "orderBy": [{ "created_at": "desc" }, { "id": "asc" }],
  "limit": 10,
  "offset": 0
}
```

with `"offset": 10` for the second page. Order by something unique last so pages never overlap.

## Results

`columns` lists each result column's `name` and `type` in select order; `rows` holds arrays of
values in that order. Values arrive in these wire forms on every engine:

| Value | Form |
|-------|------|
| 8-, 16- and 32-bit integers, floats | JSON number; a 32-bit float (`real`) as its shortest decimal (`0.1`); Postgres's float `NaN`, `Infinity` and `-Infinity` as the strings `"NaN"`, `"Infinity"`, `"-Infinity"` |
| 64-bit integers, decimals | string (`"9007199254740993"`, `"250.50"`, with the column's scale) |
| money | string: on Azure SQL with four decimal places (`"640.1000"`); on Postgres as a decimal with the currency's two places and no symbol (`"640.10"`) |
| `count`, `countDistinct` | string |
| `sum` | string over integer and decimal columns, number over float columns |
| `avg` | number: over integer and decimal columns the exact sum divided once in floating point |
| boolean | `true` / `false` |
| date | `"YYYY-MM-DD"` |
| timestamp | ISO 8601 in UTC with milliseconds (`"2026-03-31T21:59:59.987Z"`), with or without a time zone in the database; one without (`timestamp`, `datetime2`, `datetime`, `smalldatetime`) is taken as UTC; digits past the millisecond are cut, never rounded, except for SQL Server's `datetime`, whose 1/300 s ticks (`.003`, `.007`) are rounded to the nearest millisecond, and which a filter with the returned value still matches |
| json | the JSON value itself (Postgres); text on Azure SQL; an integer inside a document past 2^53 loses precision |
| anything else (uuid, uniqueidentifier, enums…) | string, as the database prints it: a uuid in lower case on Postgres, a uniqueidentifier in upper case on Azure SQL |
| null | `null` |

`warnings` holds `join_multiplies_rows` (with the join's `path`) when a relation that can match
several rows per row sits under an aggregate: the query runs, but a row may be counted more than
once.

`run_id` is the run's id in the run log.

## Limits

| Limit | `POST /v1/query` | MCP `query` tool ([mcp.md](mcp.md)) |
|-------|------------------|--------------|
| Rows, default / maximum | 1,000 / 50,000 | 100 / 5,000 |
| Result size (rows as JSON) | 10 MB | 1 MB |
| Time | the source's `timeout_ms` (default 30 s) | same |
| Queries at once | the user's limit (`USER_QUERY_CONCURRENCY` unless set for them, default 5), the source's `query_concurrency` (default 5) | the same slots, shared with `POST /v1/query` |

- The row limit is `limit`, or the default, lowered to the maximum and to the source's `row_cap`.
  A `limit` above the maximum is lowered, not refused.
- When rows were left out the response has `truncated: true` and `truncated_by`: `rows` when
  more rows existed than the limit, `bytes` when the next row would have passed the size limit.
  A result that ends exactly at the limit is not truncated.
- A query past its time limit is stopped on the source: `504 query_timeout`. The time limit is
  counted from just before the concurrency check, so time spent waiting for a connection to the
  source counts against it; a query with no time left once it has a connection is not sent.
- A query the source cannot take (`422 too_many_parameters`) is refused before the concurrency
  check, so it is never answered `429`.
- Concurrency is counted in Redis, so it holds across replicas. A user may run
  `USER_QUERY_CONCURRENCY` queries at once (1 to 100, default 5, set in the environment) unless an
  administrator gave them or one of their groups its own limit
  ([grants.md](grants.md#concurrency-limits): the user's own, else the highest of their groups');
  one more is `429 too_many_queries`. A source runs its `query_concurrency` at once (1 to 50,
  default 5, set per source, [sources.md](sources.md#the-source)); one more is `429 source_busy`.
  Both answers carry `Retry-After` and `retry_after` (seconds), and their message states the limit
  that applied. The limits are read as each query starts: a change applies to the queries that start
  after it, and queries already running go on. Exports are counted apart, against
  `USER_EXPORT_CONCURRENCY` per user (1 to 10, default 1, or the user's own limit as for queries;
  `429 too_many_exports`) and the source's `export_concurrency` (1 to 10, default 2;
  `429 source_busy`); see [export.md](export.md#limits). A query's slot is held at most the time limit
  plus 5 s, and is released as soon as the query ends, however it ends; the response does not wait
  for the release, and a release Redis does not take lapses at that expiry. When Redis fails or does
  not answer within a second, no slot can be taken and the query is `503 temporarily_unavailable`,
  recorded as `failed`.
- The body is at most 64 KB (`413 payload_too_large`).
- A client that disconnects stops its query on the source; the run is recorded as `failed` with
  `client_closed`.

## Errors

Every error is `{ error, error_description, ..., request_id }`, where `request_id` is the
request's `X-Request-ID` header, also on the server's log lines for it. A query the language
accepts but which cannot be run as written is `422` with `path` (keys and array indexes from the
root of the query) and `suggestions` (up to three close names, closest first).

- **Not granted and not there look the same.** A source, table, relation or column the caller is
  not granted is refused exactly as one that does not exist: `422 not_found_or_not_accessible`,
  message `Source|Table|Relation|Column "<name>" was not found or is not accessible`, the same path,
  and suggestions drawn only from names the caller can see. The kind in the message comes from
  where the name sits in the query, never from the catalogue.
- **The source is checked first.** The body must be a JSON object with a non-empty string
  `source`, and no string or key anywhere in it may hold NUL or ill-formed Unicode (a lone
  UTF-16 surrogate); else `400 invalid_request`, not recorded. A source the caller cannot see is
  `422 not_found_or_not_accessible` at path `["source"]` before anything else in the body is read,
  so a malformed query against it gets the same answer as a well-formed one. Against a source the
  caller can see, a body the language refuses is `400 invalid_request` with `issues`.
- If a plan ever references a column outside the caller's grants (the planner and the catalogue
  disagreeing, which is logged as an error), the answer is `422 not_found_or_not_accessible` with
  the fixed message `A name in the query was not found or is not accessible` and path `[]`.
- Other `422` codes: `missing_in_source` (the last refresh no longer found a table, column or
  relation the caller is granted), `column_not_queryable` (a column of type `other`),
  `invalid_operator`, `invalid_value`, `invalid_grouping`, `invalid_order`, `invalid_having`,
  `duplicate_output_name`, `join_parent_missing`, `too_many_joins` (at path `["join"]`: more joins than the source's `max_joins`), `too_many_parameters` (the query binds more
  values than the source's engine takes; see *Filters*).
- From running: `502 query_failed` (the source refused or failed to run the query),
  `502 source_unreachable`, `504 query_timeout`, `429 too_many_queries` / `source_busy`,
  `503 temporarily_unavailable` (group membership, Redis or the source pool briefly unavailable;
  for an export, also one started while the service shuts down, which is not recorded).
- **A database's own error text never reaches a caller.** It is logged; the response carries a
  fixed message and the request's `request_id`, which finds the log line.

## The run log

Every query past the first check (an object naming a source, with no NUL or ill-formed Unicode) is
recorded, refused and failed ones included, in one transaction that writes a `query_runs` row and a
`zeteo.query.run` audit entry. A body the source's language refuses is not recorded. Exports are
recorded in the same table, with their own audit entries ([export.md](export.md#what-is-recorded)).

- The row holds the query as sent, who ran it, the source (null when the caller could not see the
  one named), the entry point (`api`, `mcp`, `export`), the duration, the rows returned, the
  outcome, the error code and whether rows were left out. It never holds result data.
- The audit entry's metadata is `{ source_id, entry_point, outcome, error_code, row_count,
  duration_ms }`; the query itself is only in the row.
- Outcomes: `ok`; `refused` for a 4xx answer; `timeout` for `query_timeout`; `failed` for any other
  error, and for a client that went away (`client_closed`); `running` for an export that has
  started and not yet ended.
- When a run cannot be stored, it is stored again with `{ "unrecordable": true }` in place of the
  query (same outcome, code and other fields), and the failure is logged.
- Rows are sent only once their run is recorded: when neither attempt can be written, a successful
  query answers `500 server_error` and no rows. When a failed query's record cannot be written
  either way, the failure is logged and the query's own error is answered.

`GET /v1/runs` lists runs newest first, filtered by `user_id`, `source_id` and `outcome`, as
`{ id, user_id, source_id, entry_point, query, duration_ms, row_count, outcome, error_code,
truncated, created_at }`.

## Retention and housekeeping

A job runs in every replica, the first time 60 to 120 seconds after start (a random delay, so
replicas started together spread out) and then every hour, under a Redis lock
(`zeteo:job:runs-housekeeping`, 10 minutes) so one replica does each sweep. A sweep that cannot
take the lock, Redis being away, is skipped. Each sweep:

1. closes every export still `running` 15 minutes after it started (its 10-minute limit and a
   margin, so its process has died) as `failed` with `interrupted`, each with its
   `zeteo.export.run` audit entry; one that fails to close is logged and the rest go on;
2. deletes runs older than `QUERY_RUNS_RETENTION_DAYS` (default 90, 0 keeps them all), 1,000 at a
   time, never one still `running`. The deletion writes no audit entry: Tereo's audit log, where
   every run's `zeteo.query.run` or `zeteo.export.run` entry stays, is the lasting record.

The job is not started in the test suite's shared server.
