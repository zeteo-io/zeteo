# @zeteo-io/sdk

A Node.js client for [zeteo](https://github.com/zeteo-io/zeteo), the query service for apps built
on [tereo](https://github.com/tereo-io/tereo). It calls zeteo's HTTP API: running and exporting
queries, reading the catalog, and managing sources, grants and per-person limits. Requests go out
through [`@dianemo/core`](https://github.com/dianemo/dianemo), which handles the service's OAuth
token, retries and rate-limit state.

Request and response fields keep the API's names (`snake_case`). Every request and response has a
TypeScript type.

Requires Node.js 22.

## Install

```sh
npm install @zeteo-io/sdk @dianemo/core ioredis
```

`@dianemo/core` and `ioredis` are peer dependencies: the handler and Redis connection your service
passes in must be the same copies the SDK uses.

## Set up

The client needs zeteo's URL, tereo's URL (where its credentials are exchanged for a token) and
the client id and secret that your service was provisioned with in tereo. It also needs a request
handler. There are two ways to give it one.

### Your service already has a handler

If your service already uses `@dianemo/core` (for example `getHandler()` from
`@tereo-io/sdk/handler`), pass that handler. The client registers itself on it.

```ts
import { createZeteoClient } from "@zeteo-io/sdk";
import { getHandler } from "@tereo-io/sdk/handler";

const zeteo = createZeteoClient({
  url: "https://zeteo.example.com",
  tereoUrl: "https://tereo.example.com",
  clientId: process.env.ZETEO_CLIENT_ID!,
  clientSecret: process.env.ZETEO_CLIENT_SECRET!,
  handler: getHandler(),
});

await zeteo.start();
```

`stop()` does nothing to a handler you passed in; it is still yours to stop.

### The client creates its own handler

Pass an `ioredis` connection and a key. The key is a secret string that namespaces the handler's state in Redis; every
replica of your service must use the same one.

```ts
import { createZeteoClient } from "@zeteo-io/sdk";
import { Redis } from "ioredis";

const zeteo = createZeteoClient({
  url: "https://zeteo.example.com",
  tereoUrl: "https://tereo.example.com",
  clientId: process.env.ZETEO_CLIENT_ID!,
  clientSecret: process.env.ZETEO_CLIENT_SECRET!,
  redis: new Redis(process.env.REDIS_URL!),
  requestHandlerKey: process.env.REQUEST_HANDLER_KEY!,
  production: process.env.NODE_ENV === "production",
});

await zeteo.start();
// ... on shutdown
await zeteo.stop();
```

Passing both `handler` and `redis` throws, as does passing neither. A handler can carry one zeteo
client; a second `createZeteoClient` on the same handler throws.

### Call `start()` first

`await zeteo.start()` must complete before the first call. If the handler you passed in is itself
still starting, the client is only guaranteed to be registered once `start()` has resolved.

The optional `getRequestId` option returns the current request's id; it is sent to zeteo as
`X-Request-ID`, so a request can be followed through both services.

## What your service needs in tereo

Two identities can call zeteo, and tereo has to allow both.

In your service's provisioning document:

```json
{
  "access": {
    "audiences": ["zeteo"],
    "roles": ["zeteo/zeteo_user"]
  }
}
```

- `access.audiences` lists `zeteo`, so zeteo accepts your service's token.
- `access.roles` names a zeteo system role. `zeteo/zeteo_user` lets the service query and read the
  catalog. `zeteo/zeteo_admin` allows everything, including export and managing sources, grants and
  limits. A service that should export needs `zeteo/zeteo_admin` today, because zeteo declares no
  role that grants export without administration.
- For people's tokens, the login client they sign in through needs an `audience` that includes
  `zeteo`.

Whatever the identity, zeteo's own grants decide which tables and columns it may read. A grant
names the service account's user, or a person or one of their groups.

## Two identities

Calls on `zeteo` go out as your service, with the service's own token:

```ts
const catalog = await zeteo.catalog.get();
```

`zeteo.withToken(token)` returns the same calls, sent with a person's bearer token instead. Use it
to query as the signed-in person, so they see only what their grants allow. It is cheap: make one
per request.

```ts
const asPerson = zeteo.withToken(req.headers.authorization!.replace(/^Bearer /, ""));
const result = await asPerson.query.run({ source: "sales-db", from: "orders", select: ["id"] });
```

The token is used as given, after `Bearer `. `withToken("")` or a value that is not a string
throws. A 401 on the service's token makes the client fetch a new token and repeat the call once. A
401 on a person's token is thrown as it is.

`zeteo.health.get()` sends no token under either identity.

## Run a query

```ts
const result = await zeteo.query.run({
  source: "sales-db",
  from: "orders",
  join: ["customer"],
  select: [
    "customer.region",
    { sum: "total", as: "revenue" },
  ],
  where: { status: { in: ["paid", "shipped"] } },
  groupBy: ["customer.region"],
  orderBy: [{ revenue: "desc" }],
  limit: 100,
});

console.log(result.columns); // [{ name: "region", type: "text" }, ...]
console.log(result.rows);    // [["EMEA", "1200.50"], ...]
if (result.truncated) console.log(`cut by ${result.truncated_by}`);
```

Each row is an array in the order of `columns`. 64-bit integers, decimals, `count` and `sum` over
integers come back as strings, so no precision is lost; see the `QueryResult` type for every form.
The query language itself is described in zeteo's documentation (`docs/querying.md`).

Both `query.run` and `export.*` accept `{ signal }` to cancel the request.

## Health

```ts
const health = await zeteo.health.get();
if (health.status === "degraded") console.warn(health);
```

`health.get()` resolves a degraded (503) status instead of throwing, so you can read which
dependency failed. Any other failure throws a `ZeteoError`: another error status, a 503 without a health body, or no
response at all.

## Export

An export streams every row of a query, past the limit that `query.run` is held to, to a caller
that reads them as they arrive. The calling identity needs export permission.

### Rows

```ts
const out = await zeteo.export.rows({
  source: "sales-db",
  from: "orders",
  select: ["id", "total"],
});

console.log(out.runId, out.columns);
for await (const row of out.rows) {
  // row is an array in the order of out.columns
}
const end = await out.done; // { status: "complete" | "truncated", rows: number }
```

- `rows` can be read once.
- The connection is held until you iterate `rows` to its end, leave the loop early (`break`), or
  abort the `signal` you passed. Do not abandon an export you are not reading.
- `done` tells a complete export from a truncated one: `status` is `"truncated"` when zeteo
  sent only the first rows because more existed than the source's export row cap allows.
- If the connection is cut or the stream ends without zeteo's last line, the iterator throws
  `ExportInterruptedError` (with `runId` and `rowsRead`) and `done` rejects with the same error. A
  broken export is never reported as a finished one.
- An export is never repeated. The one exception: when zeteo rejects the service's token with a
  401, the client fetches a new token and sends the export once more, before any of the stream has
  started.

### Stream

`export.stream` gives you the response body as a Node `Readable`, as NDJSON (the default) or CSV,
to send on to a file or a download:

```ts
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const { runId, stream } = await zeteo.export.stream(
  { source: "sales-db", from: "orders", select: ["id", "total"] },
  { format: "csv" }
);
await pipeline(stream, createWriteStream(`orders-${runId}.csv`));
```

The stream is not checked for completeness; that is up to you (the last NDJSON line, or the CSV's
trailers). Use `export.rows` when you need that check done.

## Pagination

List calls take `{ limit?, cursor?, ...filters }` and return `{ data, next_cursor }`. `paginate`
walks every page:

```ts
import { paginate } from "@zeteo-io/sdk";

for await (const source of paginate(zeteo.sources.list)) {
  console.log(source.slug);
}

for await (const run of paginate(zeteo.runs.list, { outcome: "failed" })) {
  console.log(run.id);
}
```

## The other calls

| Group | Calls |
|---|---|
| `health` | `get()` |
| `catalog` | `get({ source? })` |
| `query` | `run(query, { signal? })` |
| `export` | `rows(query, { signal? })`, `stream(query, { format?, signal? })` |
| `runs` | `list(options?)` |
| `sources` | `list`, `get`, `create`, `update`, `archive`, `test`, `refresh` |
| `sources.tables` | `list(sourceId)`, `get(sourceId, tableId)`, `update(sourceId, tableId, body)` |
| `sources.relations` | `list(sourceId)`, `declare(sourceId, body)`, `delete(sourceId, relationId)` |
| `grants` | `list`, `get`, `create`, `replace`, `delete` |
| `principalLimits` | `list`, `get`, `create`, `update`, `delete` |
| `me` | `get()` |
| `principals` | `search({ type, q, limit? })`, `lookup(principals)` |

`sources.get`, `sources.tables.get`, `grants.get` and `principalLimits.get` resolve `null` on a
404; every other call, `catalog.get` included, throws on it. An id that is empty, is exactly `.`
or `..`, or contains `/`, `\`, `?` or `#` throws `ZeteoError` with code `invalid_id` before any
request is made.

### Who is calling, and finding principals

`me.get()` returns the caller's `id`, `type` (`user` or `service`), `name`, `email` (both `null`
when tereo cannot be reached or does not know the user) and held `zeteo.` `permissions`. It needs
only a valid token, so `zeteo.withToken(token).me.get()` tells your service what a signed-in
person may do.

```ts
const { data } = await zeteo.principals.search({ type: "group", q: "analy", limit: 5 });
const named = await zeteo.principals.lookup([{ type: "user", id: userId }]);
```

`principals.search` finds users or groups by name for choosing who a grant is for; `limit` is 1 to
25 and `q` 2 to 100 characters. `principals.lookup` answers 1 to 100 `{ type, id }` pairs by id; one
tereo does not have comes back `orphaned` with a `null` name. Both resolve `{ data: Principal[] }`,
where a `Principal` has `type`, `id`, `name`, `status` (`active`, `inactive` or `orphaned`) and,
for users, `email`. `search` needs `zeteo.grants.read`; `lookup` accepts `zeteo.grants.read` or
`zeteo.runs.read`. A search past 60 a minute per caller throws `ZeteoError` with status 429 and
`retryAfter`. `lookup` changes nothing, so it is repeated after a 5xx like a GET.

## Errors

Every failure of a call is a `ZeteoError`, except an interrupted export:

| Field | Meaning |
|---|---|
| `status` | HTTP status, or `null` when there was no response |
| `code` | The API's `error` code; `http_<status>` (for example `http_502`) when the body has none; or one the package raises itself: `unreachable`, `aborted`, `invalid_id`, `invalid_token`, `invalid_response`, `pagination_stuck` |
| `message` | The API's `error_description`, else the HTTP status text |
| `requestId` | zeteo's request id, when it sent one |
| `issues`, `findings` | Validation issues, or the findings of a source login check, when present |
| `retryAfter` | Seconds, on a 429 or 503 |

- `QueryRefusedError` (a `ZeteoError`) is thrown for a 422 from `query.run` or `export.*`. It adds
  `path`, where in the query the problem is, and `suggestions`, close names that exist.
- `ExportInterruptedError` is described under Export.

No error carries a bearer token, the client secret or request headers. An error's `cause` is a
plain `Error` holding only the underlying message.

### Retries

| Case | Behaviour |
|---|---|
| 500, 503 (`temporarily_unavailable`), or a 502 or 504 without one of zeteo's codes below (from a proxy or load balancer in front of zeteo), on a GET, `query.run`, `principals.lookup`, `replace` or `delete` | Repeated for that call only, up to three times with backoff (1 s, 4 s, 9 s), waiting at least as long as the response's `Retry-After` header asks, in seconds or as an HTTP date; other calls are not held back |
| 502 whose body's `error` is `query_failed` or `source_unreachable`, 504 whose body's `error` is `query_timeout` | Thrown; not repeated, and other calls are not held back |
| Another 5xx, or a dropped connection, on a GET, `query.run`, `principals.lookup`, `replace` or `delete` | Repeated by the handler with backoff; meanwhile the client's other calls are held back |
| `create`, `declare`, `update`, `archive`, `refresh`, `test`: 5xx or dropped connection | Not repeated; zeteo may have acted |
| Export | Never repeated (the one exception: a single renewal of a rejected service token before the stream starts) |
| 429 (`too_many_queries`, `source_busy`) | Thrown with `retryAfter`; not repeated, and other calls are not held back |
| Other 4xx | Thrown |

A 429 means one person or one source is at its concurrency limit, not that your service is over a
rate, so the client keeps serving other calls.

## Not included

- Use in a browser; the package is for Node.js services.
- A test mode or fake client; point a client at a stub server instead.
- A query builder; a query is a plain object of the `Query` type.
- CSV parsing; `export.stream` hands you the bytes.

## Licence

Apache-2.0.
