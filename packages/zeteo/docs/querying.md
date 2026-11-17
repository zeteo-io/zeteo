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

Every example in this page, and in the MCP instructions, runs on one small source, `sales-db`.
Relation names follow the discovery rules: a single foreign key is named after its target table
(`orders` to `customers` is `customers`), and the reverse side after the table holding the key
(`customers` to `orders` is `orders`).

- `customers` (id, name, first_name, last_name, email, region); relation `orders`
- `orders` (id, customer_id, status, total, created_at); relations `customers` and `order_lines`
- `order_lines` (id, order_id, product_id, unit_price, quantity, discount, unit_cost); relations
  `orders` and `products`
- `products` (id, name, category); relation `order_lines`

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
  of a joined table, and `order_lines.products.category` one reached through two relations.
- **`join`** lists relations by name (see `docs/catalog.md`), `inner` by default or
  `{ "relation": "...", "type": "left" }`. A relation reached through another is joined after it:
  `["order_lines", "order_lines.products"]`. At most the source's `max_joins` joins (4 unless the source sets more, up to 8; a query over the source's limit is `422 too_many_joins`). A relation can be used only when every key
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

### Filters

A filter is one of:

- `{ "and": [filter, ...] }`, `{ "or": [filter, ...] }`, `{ "not": filter }`;
- `{ "<path>": { "<operator>": value }, ... }`: each path takes exactly one operator, and several
  paths in one object must all hold.

| Operator | Value | Applies to |
|----------|-------|------------|
| `eq`, `ne`, `gt`, `gte`, `lt`, `lte` | a value | text, number, date, timestamp; `eq`/`ne` also boolean |
| `between` | `[low, high]`, inclusive | text, number, date, timestamp |
| `in`, `notIn` | 1 to 1,000 values | text, number, date, timestamp, boolean |
| `contains`, `startsWith` | a string | text: case-insensitive whatever the collation, `%`, `_` and `[` match themselves |
| `isNull` | `true` or `false` | every type, json included |

Values are checked against the column: text takes a string; numbers a number or a decimal string
(`"9007199254740993"`, so 64-bit integers and decimals lose nothing); booleans `true` or `false`;
dates `YYYY-MM-DD`; timestamps ISO 8601 with `T`, seconds and an offset or `Z`
(`2026-03-31T20:30:00-03:30`), compared as instants. Filters nest at most 5 deep.

Every value is bound as a parameter, and an engine takes only so many in one statement: 2,098 on
Azure SQL (SQL Server's 2,100, less two the driver uses), 65,535 on Postgres, paging's two
included. A query that binds more, which takes several long `in` lists, is refused before it
runs with `422 too_many_parameters` at path `[]`. A timestamp's fraction past 100 ns is cut on
Azure SQL, its precision.

A value that has the right shape but that the source itself cannot convert to the column's type
is the caller's error: `422 invalid_value` at path `[]`, with the fixed message `A value in the
query could not be converted to its column's type`, recorded as `refused`. On Postgres that is a
malformed uuid, or a timestamp offset beyond ±15:59; on Azure SQL a malformed uniqueidentifier, a
timestamp offset beyond ±14:00, a timestamp that leaves years 1 to 9999 once converted to UTC, and
a bound outside 1753-01-01 to 9999-12-31 compared with a `datetime` column.

**Postgres's own types.** A uuid column compares as a uuid (`eq`, `ne`, `in`, `notIn`, ranges), so
its index is used and the value's case does not matter; `contains`, `startsWith`, `min` and `max`
read it as text. An enum column is read as text everywhere: a label the enum does not have
matches nothing, and it sorts, and `min` and `max` compare, alphabetically, not in the enum's
order. A money column is read as numeric everywhere, so it filters, sums and averages like a
decimal. A domain behaves as its base type.

**Reserved names.** `and`, `or` and `not` are always logical operators. A column with one of those
names cannot be filtered on directly (select it through a view that renames it), and an `as` of
`and`, `or` or `not` cannot be used in `having`.

**`eq` on text follows the database's collation**, which differs between engines: Postgres
compares exactly, case and accents included, unless the column has a case-insensitive collation;
Azure SQL's default collations ignore case, so `{ "eq": "paid" }` also matches `PAID` there. Use
`contains` or `startsWith` for a match that ignores case on every engine. Sorting text follows the
collation too, and so does what `distinct` and `groupBy` count as the same text.

**Where the engines differ.** Over the types both have, the engines return the same rows, in the
same order, in the same wire forms, except:

- text compared, sorted, deduplicated or grouped follows each database's collation (above);
- money prints with four decimal places on Azure SQL (`"640.1000"`) and two on Postgres
  (`"640.10"`);
- a uuid prints in lower case on Postgres and a uniqueidentifier in upper case on Azure SQL, and
  they sort differently: Postgres in the order of their text, SQL Server in its own byte order
  (which `min` and `max` follow too; on Postgres they compare the text);
- json is the JSON value on Postgres and text on Azure SQL;
- a timestamp's fraction past 100 ns is cut on Azure SQL, and its `datetime` holds 1/300 s ticks
  (see *Results*);
- a value one engine cannot convert fails there as `422 invalid_value` (see *Filters*): a timestamp
  offset beyond ±14:00 on Azure SQL but only beyond ±15:59 on Postgres, and a bound outside
  1753-01-01 to 9999-12-31 compared with a `datetime` column on Azure SQL, which Postgres has no
  counterpart of.

Types only one engine has behave as that engine's section says: on Postgres, an enum sorts as its
text and a money column computes as numeric (see *Postgres's own types*); float `NaN` and
`Infinity` are Postgres's alone.

### Relative dates

A date or timestamp in a comparison (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`) or in `between` (not `in`) may be
a moment relative to now: `{ "relative": { "unit": "day", "offset": -30 } }`. `unit` is `minute`,
`hour`, `day`, `week`, `month`, `quarter` or `year`; `offset` is a whole number from -1000 to 1000;
`startOf: true` cuts the result back to the start of the unit (a week starts on Monday). It is
resolved in UTC when the query is planned: `now` is the minute the run started (the dashboard
run's own minute, for all of its panels), a date column takes the date of the moment, and a
relative moment against any other type is `invalid_value`. Orders in the last 30 days:

```json
{ "source": "sales-db", "from": "orders", "select": [{ "count": "*", "as": "orders" }],
  "where": { "created_at": { "gte": { "relative": { "unit": "day", "offset": -30 } } } } }
```

A saved query keeps the relative date as written, so each run answers for its own now.
Dashboards ([dashboards.md](dashboards.md)) build their time ranges from it.

### Json columns

A json column can be selected and tested with `isNull`, nothing else: it cannot be compared,
grouped, deduplicated (`distinct`, `countDistinct`) or sorted (`invalid_operator`). A query whose
select items are all json has no default order. On Azure SQL json is stored as text (`nvarchar`):
its columns are text columns there.

## Calculations

An **expression** is a column path (`"unit_price"`, `"products.name"`), a number, a text literal
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

- A select item: `{ "calc": expression, "as": "name" }`; `as` is required. A calculation reads
  at least one column (an aggregate such as `{ "count": "*" }` also counts): one built only of
  literals is refused with `422 invalid_operator` at the item's path, `["select", i]`.
- An aggregate's argument: `{ "sum": { "mul": ["unit_price", "quantity"] }, "as": "revenue" }`.
  `sum`, `avg`, `min` and `max` take an expression where they took a path, and then need `as`;
  `count` and `countDistinct` stay paths.
- By name elsewhere: a calculation's `as` works in `groupBy` and `orderBy`, in `having` when it
  is group-level, and in `where` when it is row-level (zeteo puts the calculation itself into the
  WHERE clause, since SQL cannot name a select alias there). A `where` key that names a
  calculation or an aggregate is read as that item, any other as a column path; a calculation's
  or aggregate's name that is also a column is `422 duplicate_output_name`: pick another `as`.

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
or numbers (numbers are converted to text). Dates, booleans, json and `other` columns are refused,
except in `coalesce`, with `422 invalid_operator`, at the path of the operand (`path` is a list of keys and indexes, such
as `["select", 2, "sum", "mul", 1]`). `coalesce` operands must share one type. Every column an expression reads goes through the usual column resolution, so
grants, joins and `not_found_or_not_accessible` work as for a plain path, and the run record lists
the columns read. A result is typed in `columns` like any select item; decimals arrive as strings.

**Precision.** Both databases give the same value, not necessarily the same digits after the
point. `div` is a decimal division that keeps at least 6 decimal places (the most SQL Server
guarantees); wrap it in `round` to get exactly the places you want, which is also the way to
identical text on both. Integer `add`, `sub` and `mul` can overflow, which is `502 query_failed`.
Literals are bound parameters and count towards the parameter limit.

**Precision and limits across databases.** `div` returns 6 decimal places, rounded half away from
zero; its numerator may have up to 20 integer digits (more is `502 query_failed`) and its divisor is
read to 10 places, so a non-zero divisor below 5e-11 counts as 0 and gives null. `round` reads its
operand to 10 places. On SQL Server a column times a column is computed at SQL Server's decimal
precision, which can drop places a chain of high-precision decimal columns would keep on Postgres.
A uniqueidentifier read inside a calculation is lower-case on both databases. Money inside `concat`
prints 2 places.

**Limits.** An expression nests at most 8 levels (an aggregate counts as one), a query holds at
most 100 operation and aggregate objects in all, `add`, `mul`, `concat` and `coalesce` take 2 to
10 operands, and `round` places are 0 to 10.

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

Margin percentage by product category (group-level): revenue and cost are computed from the lines,
and the percentage is rounded to one place (this nests 6 levels):

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
            "mul": [
              100,
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
              }
            ]
          },
          1
        ]
      },
      "as": "margin_pct"
    }
  ],
  "groupBy": ["products.category"],
  "orderBy": [{ "margin_pct": "desc" }]
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

## Discovering what you can query

`GET /v1/catalog` (`zeteo.data.read`) answers what the caller may query, so a person or an AI
can write a query without being told the schema. It shows exactly the caller's grants (their own
and their groups') and nothing else: no ids, no native types, no connection settings, and no
trace of a table, column, relation or source they are not granted.

```json
{
  "sources": [
    {
      "slug": "sales-db",
      "name": "Sales",
      "type": "postgres",
      "language": { "id": "sql", "schema": { "type": "object", "properties": { "select": {} } } },
      "limits": {
        "default_rows": 1000,
        "max_rows": 50000,
        "timeout_ms": 30000,
        "max_joins": 4,
        "export": { "enabled": true, "max_rows": 200000 }
      },
      "tables": [
        {
          "name": "orders",
          "schema_name": "sales",
          "kind": "table",
          "description": null,
          "missing": false,
          "columns": [{ "name": "id", "type": "number", "nullable": false, "description": null, "missing": false }],
          "relations": [{ "name": "customers", "to": "customers", "to_many": false, "missing": false }]
        }
      ]
    }
  ]
}
```

- Without `?source=<slug>`, every source the caller has a grant on, ordered by slug; archived
  sources never appear. A `source` that is unknown, archived or not granted gives `sources: []`,
  exactly as a caller with no grants gets.
- Tables are ordered by schema, then name; columns in the table's own order, only those granted.
- A table's `name` is what a query writes in `from`: the bare name when no other table the caller
  can see in that source has it, else `schema.table`.
- A relation is listed under the table it starts from. Its `name` is what a query's `join`
  names (through a joined relation, `order_lines.products`); `to` is the target table as `from` would
  write it. A relation appears only when every key column on both sides is granted.
- `limits` are those of `POST /v1/query`: `default_rows` and `max_rows` are lowered to the
  source's `row_cap`, `timeout_ms` is the source's time limit, `max_joins` the most joins one
  query may name. `export` says whether the source
  takes exports (`enabled`: `export_enabled` and an `export_row_cap` above 0) and up to how many
  rows (`max_rows`, 0 when it does not); exporting also needs `zeteo.data.export`.
- `language.schema` is the JSON Schema of the query body.
- `missing` marks a table, column or relation the last refresh did not find; a query that uses
  one fails with `missing_in_source`.

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
  one named), the entry point (`api`, `mcp`, `export`, `dashboard`), the duration, the rows returned, the
  outcome, the error code and whether rows were left out. It never holds result data.
- The audit entry's metadata is `{ source_id, entry_point, outcome, error_code, row_count,
  duration_ms }`; the query itself is only in the row.
- Outcomes: `ok`; `refused` for a 4xx answer; `timeout` for `query_timeout`; `failed` for any other
  error, and for a client that went away (`client_closed`); `running` for an export that has
  started and not yet ended.
- A run of a saved query ([saved-queries.md](saved-queries.md)) is the same row with the saved
  query's id, and its query is the stored JSON as run. When the caller was refused it as
  `saved_query_not_accessible`, the row holds `{ "withheld": true }` as the query and a null
  `source_id`, so the caller's own runs never show what the refusal withholds.
- When a run cannot be stored, it is stored again with `{ "unrecordable": true }` in place of the
  query (same outcome, code and other fields), and the failure is logged.
- Rows are sent only once their run is recorded: when neither attempt can be written, a successful
  query answers `500 server_error` and no rows. When a failed query's record cannot be written
  either way, the failure is logged and the query's own error is answered.

A dashboard panel's run has the entry point `dashboard` and the saved query's id. It is recorded at
most once per viewer per query in `DASHBOARD_RECORD_WINDOW_MINUTES` (default 60), and its row keeps whether
the result was served from the dashboard cache; every other entry point records every run
([dashboards.md](dashboards.md#the-recording-window)).

`GET /v1/runs` lists runs newest first, filtered by `user_id`, `source_id` and `outcome`, as
`{ id, user_id, source_id, entry_point, query, duration_ms, row_count, outcome, error_code,
truncated, created_at }`, and `saved_query: { id, name }` for a run of a saved query that still
exists. `GET /v1/me/runs` is the same list for the caller alone.

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
