# Server tests

`src/tests` mirrors `src/`. A source path tells you which test file covers it, and a test's path
tells you what it covers. `src/tests/conventions/testLayout.unit.test.ts` enforces every rule below
and lists the offending paths when one breaks.

## Where files go

| Source                                    | Test                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| router folder `routes/v1/sources/source/` | `routes/v1/sources/source/source.test.ts`                          |
| root router `routes/index.ts`             | `routes/routes.test.ts` (e.g. `routes/routes.permissions.test.ts`) |
| module `utils/permissions.ts`             | `utils/permissions.unit.test.ts`                                   |
| job `jobs/sourceProbe.ts`                 | `jobs/sourceProbe.test.ts`                                         |
| entry points `index.ts`, `app.ts`         | `index.test.ts`, `app.test.ts`                                     |
| behaviour spanning several routes         | `flows/<area>/<flow>.test.ts` (one folder per area, not nested)    |
| checks on the repo's own conventions      | `conventions/<name>.unit.test.ts`                                  |

Not tests: `setup/` (`globalSetup.ts`, `setup.ts`, `testEnv.ts`, `tags.ts`), `support/` (shared
helpers; `support/pure/` holds those with no database, server or Redis), `fixtures/` (static data and
child-process scripts).

A test that exercises one route belongs to that route even if it sets up state through others.
`flows/` is for tests whose subject is a sequence across routes.

## Filenames

```
<base>[.<aspect>][.<method>][.unit].test.ts
```

- `<base>`: the router folder's name or the source file's name, camelCase as in `src/`.
- `.unit`: pure; no database, server, Redis or outside network; a loopback listener the test itself starts and closes is fine. Absent means `int`.
- `<aspect>`, from the list in `setup/tags.ts`:

  | Aspect        | Holds                                                                 |
  | ------------- | --------------------------------------------------------------------- |
  | `validation`  | input and schema checks                                               |
  | `permissions` | route-specific authorization (org scope, ownership, hierarchy)        |
  | `races`       | concurrency and lock-order behaviour                                  |
  | `audit`       | audit entries a mutation records                                      |
  | `limits`      | quotas, size caps, rate limits, pagination bounds                     |
  | `errors`      | error mapping and failure paths                                       |
  | `leak`        | that what a caller may not see fails exactly like what does not exist |
  | `injection`   | that hostile names and values stay identifiers and parameters         |
  | `property`    | generated inputs checked against an invariant (fast-check)            |
  | `postgres`    | behaviour specific to the Postgres dialect                            |
  | `mssql`       | behaviour specific to the SQL Server dialect                          |

- `<method>`: `get`, `post`, `put`, `patch` or `delete`; only as the last-resort split below.
- A file without an aspect holds the main behaviour. Add aspect files only when the main file would
  pass the cap, or when the aspect is a distinct tier (`.validation.unit`).

## Size cap

No `.ts` file under `src/tests` (test or support, `fixtures/` excepted) exceeds 800 lines. Split by
aspect; if one aspect still exceeds it, split by method (`user.validation.patch.unit.test.ts`). No
free-form names.

A file that still cannot fit is listed in `conventions/oversize.ts` with its path, a line ceiling and
a reason. The layout test fails on an unlisted file over 800, on a listed file past its ceiling, and
on a listed file that is at or under 800 or gone, so the list is the complete record of oversize files.

## Projects

| Project | Includes                | Setup                                                  | Files       |
| ------- | ----------------------- | ------------------------------------------------------ | ----------- |
| `unit`  | `**/*.unit.test.ts`     | none: no server, and an unreachable database and Redis | in parallel |
| `int`   | every other `*.test.ts` | `globalSetup`: migrates, starts one server             | serial      |

A `.unit` file must not import any of these: `utils/db/`, `utils/redis.ts`, the entry points
`app.ts` and `index.ts`, `setup/` (only `setup/tags.ts` is allowed) and `support/` (only
`support/pure/` is allowed). The check covers direct imports only.

`int` tests run against the real server, Postgres and Redis, with no mocks of them. The Azure SQL
adapter's tests also need SQL Server: `docker compose up -d mssql` from the repository root (host
port 1463; `TEST_MSSQL_URL` points elsewhere). `globalSetup` recreates its `zeteo_fixture` database
from `fixtures/mssql/sales.sql` and fails at once, saying how to start it, when it is not up.

The query suites run once per engine through `describeEachEngine` (`support/engines.ts`), each
`describe` named `<name> (postgres)` or `<name> (azure-sql)`. One engine's part:
`npx vitest run --project int -t "(azure-sql)"`.

## Tags

Declared in `setup/tags.ts`. File-level tags go at the top of the file, one per line (several on one
line silently drop all but the first):

```ts
// @module-tag int
// @module-tag platform
```

| Tag        | Kind   | Description                                      |
| ---------- | ------ | ------------------------------------------------ |
| `unit`     | tier   | Runs with no database, Redis or server           |
| `int`      | tier   | Runs against the real server, Postgres and Redis |
| `platform` | area   | Health, startup and shutdown                     |
| `race`     | detail | Concurrent requests or processes                 |
| `job`      | detail | Background jobs and schedulers                   |
| `security` | detail | Security properties and attack paths             |
| `slow`     | detail | Takes long; raises the test timeout              |

Exactly one tier tag per file, matching `.unit`. At least one area tag; the first is the primary one, and it must be the one the path
requires (`AREA_BY_PATH` in `tags.ts`, longest prefix wins). Detail tags are optional, at file,
`describe` or `it` level.

## What gets tested where

- **Validation**: table-driven `it.each` in `<base>.validation.unit.test.ts` against the route's
  exported Zod schemas. The route's `int` file keeps one case proving the schema is wired in and the
  400 has the service's error shape.
- **Auth enforcement**: a test of the root router walks every mounted route and asserts 401 without a token and 403 with
  a token without permissions, once routes need auth. Per-route files test only
  route-specific authorization (`.permissions`).
- **Side effects**: one test per mutation for the audit entry it records.
- **Business logic, database behaviour, races, sweeps, jobs**: `int`.
- **Duplicates**: the more expensive tier's copy goes. List each removal in the commit message as
  `removed: <old file> > <test name> -> covered by <new file> > <test name>`.

## Conventions inside a file

- The top-level `describe` names the route (`"PATCH /v1/sources/:id"`) or the exported function
  (`"processEntryRetention"`); `it` names state the behaviour (`"returns 409 when the slug is taken"`).
- A file covering several methods of one route may name its top-level `describe` by the path alone (`"/v1/sources"`); otherwise use `"METHOD /path"`.
- Helpers come from `support/`: `http.ts` (`fetchJson`, `BASE_URL`), `v1App.ts` (a `/v1` router served from the test's own process), and `pure/` for helpers `unit` files may import.
- Unique names, cleanup in `afterAll`.

## Commands

```sh
npm run test:unit                                   # unit project; no Docker, DB or Redis needed
npm run test:int                                    # int project; postgres, redis and mssql up
npm run test:local -- --tags-filter "auth && race"  # any tag expression, both projects
npx vitest --list-tags
npm test                                            # docker/test/run.sh
```

## Where does my test go?

1. **A new route, `POST /v1/sources`.** The router folder is `routes/v1/sources/`; the test is
   `routes/v1/sources/sources.test.ts`, tagged `int` and the route's area.
2. **A change to a Zod schema.** `routes/v1/sources/source/source.validation.unit.test.ts`, tagged
   `unit`, with `it.each` against the exported schema. Keep one 400 case in `source.test.ts`.
3. **A job, `jobs/sourceProbe.ts`.** `jobs/sourceProbe.test.ts`, tagged `int` and `job`.
4. **A flow across routes.** `flows/<area>/<flow>.test.ts`, tagged `int` and the area. If one route
   is the subject, it belongs to that route instead.
