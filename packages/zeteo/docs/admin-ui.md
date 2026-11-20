# Admin UI

The admin UI is a web page served from zeteo's own origin. Its build (`packages/zeteo-ui`) ships
in zeteo's image, and zeteo serves it at `/` once `UI_CLIENT_ID` names its login client in Tereo;
without `UI_CLIENT_ID` the image runs as an API only and `/` is a JSON `404`. This document covers
turning it on, what each screen does, local development, and what zeteo provides for it:
`GET /v1/me`, `GET /v1/principals` (and `/all`), `POST /v1/principals/lookup`, the public `GET /ui-config.json`,
a content security policy on every response, and the serving of the build. The server side is
exercised end to end by `e2e/tests/me.e2e.test.ts`, `directory.e2e.test.ts` and
`uiSignIn.e2e.test.ts`, and the UI itself in Chromium by `e2e/browser/admin.spec.ts`.

## Turning it on

| Variable | Default | Meaning |
|----------|---------|---------|
| `UI_CLIENT_ID` | unset (off) | The OAuth client id of the UI's login client in Tereo, 1 to 64 characters. Unset, the UI is not served and `/ui-config.json` answers `404` |
| `UI_TEREO_URL` | `TEREO_URL` | The Tereo URL the browser calls. It is published to browsers at `/ui-config.json`. It must be `https` when `PUBLIC_URL` is `https` (a page served over https cannot call an http origin: browsers block mixed content); under an `http` `PUBLIC_URL` an `http` URL is accepted, in production too. It may carry no credentials, query or fragment. Set it whenever `TEREO_URL` is an internal address |
| `UI_DIST_PATH` | `packages/zeteo-ui/dist` | The UI build to serve; a relative path resolves from `packages/zeteo`. Without an `index.html` there the UI is not served, and the start log says why |

`GET /ui-config.json` returns `{ "tereo_url": "...", "client_id": "...", "uploads": true }`,
needs no sign-in and answers whenever `UI_CLIENT_ID` is set, build or not. `uploads` is true
when `UPLOADS_READER_URL` is set (its value is never sent); the UI shows Uploads only
then.

## The login client in Tereo

The UI signs in with [`@tereo-io/react`](https://www.npmjs.com/package/@tereo-io/react): the
authorization code flow with PKCE, as a public client. A deploy declares the client in a
provisioning document of Tereo (`PROVISIONING_PATH`), next to zeteo's own:

```json
{
  "version": "1.0.0",
  "clients": [
    {
      "clientId": "zeteo-ui",
      "name": "Zeteo admin UI",
      "clientType": "public",
      "grantTypes": ["authorization_code", "refresh_token"],
      "redirectUris": ["https://zeteo.example.com/callback"],
      "postLogoutRedirectUris": ["https://zeteo.example.com/"],
      "scopes": ["openid", "profile", "email", "offline_access"],
      "audience": ["zeteo"],
      "consentRequired": false,
      "liveEvents": true
    }
  ]
}
```

- `clientId` is the value of `UI_CLIENT_ID`; `audience: ["zeteo"]` is what makes zeteo accept the
  token.
- `liveEvents: true` lets the page open Tereo's socket and hear when the person's permissions
  change. It replaces a core scope: the client asks for none of core's own scopes.
- `redirectUris` is `<zeteo's origin>/callback` and `postLogoutRedirectUris` `<zeteo's origin>/`,
  each matched exactly, port included.
- Tereo's `CORS_ALLOWED_ORIGINS` must list zeteo's public origin
  (`https://zeteo.example.com`): the browser exchanges its code and renews its token at Tereo from
  that origin, and without the entry it cannot do either.
- **Same site.** zeteo and Tereo must be on the same site (for example `zeteo.example.com` and
  `tereo.example.com`; `localhost` and `127.0.0.1` with different ports count as one). Tereo's
  refresh cookie is `SameSite`, so a page on another site cannot renew its session.

## Where the session lives

The access and ID tokens are kept in `localStorage` (the package's design), so any script on
zeteo's origin can read them; the content security policy below is what keeps other scripts out.
The refresh token is never in the page: Tereo sets it in an httpOnly cookie on its own origin and
the page renews its tokens with that cookie. Tabs share one session, and only one of them renews
it at a time.

A reload or a new tab signs in from the stored tokens (or, with none, from the cookie) without
a visit to Tereo's sign-in page. A person who opens a page signed out lands on `/signed-out`; its
**Sign in** button goes through Tereo and back to the page they asked for.

## The screens

Sign-in goes through Tereo's own sign-in page and back to `/callback`. Each section shows only to
someone holding its permission; a person with no zeteo admin permission at all sees a "No access"
page and no sections.

- **Sources** (`zeteo.sources.read`, changes with `.write`): the registered databases with their
  status, and upload sources with their owner, filtered by kind; every source links to its page,
  `/sources/<id>`. A new source takes its connection (host, port, database, login, TLS mode and an optional
  CA certificate), its schemas and its limits. A source's page runs **Test** (does the login hold
  rights a read-only one would not), **Refresh** (reads the catalogue again and says what changed),
  edits and archives it.
- A source's page, `/sources/<id>` for a database and an upload source alike, has one header (name, slug, kind and status, with the actions of its kind) and the tabs
  **Overview**, **Tables**, **Relations** and **Shared with**. Overview shows the querying and
  export limits, and for a database the catalogue (schemas, last refresh, size on disk of its
  schemas' tables as measured at that refresh, "Unknown" when it could not be read) and the
  connection; for an upload source its owner, size, tables and when it was added. With
  `zeteo.sources.write`, the Querying and Exports sections each have an **Edit** that opens the
  limits dialog (time limit, row cap, concurrency, exports), for both kinds of source.
- **Measures**, a source's tab (`/sources/<id>/measures`; read by anyone who may see measures,
  changed with `zeteo.measures.write` as an editor of the source): the list with description,
  used-by counts and a broken flag; a dialog to create or edit with JSON editors for the formula and
  filter, validated live against the server with plan errors shown at their paths, and **Preview**
  of the draft; who may edit measures (users and groups, changed with `zeteo.sources.write` or by an
  upload source's owner). Details: [measures.md](measures.md).
- **Calendar** (`/calendar`, open to anyone with `zeteo.data.read`, listed in the Admin menu only
  for `zeteo.calendar.write` or `zeteo.sources.read`, changed with `zeteo.calendar.write`): working days, fiscal year start month, time zone on the left, and a
  table of holidays on the right (Add holidays opens a dialog to add them row by row or paste a list;
  remove per row), noting this year or next when it has none. Details:
  [calendar.md](calendar.md).
- **Tables** and **Relations**: the catalogue as zeteo last read it. A table's page shows its
  columns and relations and edits the table's and columns' descriptions; Relations lists the
  relations read from the database and declares, renames or removes the ones it lacks.
- **Shared with** (`zeteo.grants.read`, changes with `.write`): every grant on the source's
  tables; **Share** grants a table (all columns or chosen ones) to a person or group.
- **Grants** (`zeteo.grants.read`, changes with `.write`): who may query which table, filtered by
  source, table or person. A grant names a user or group (searched by name or email, or pasted as
  an id) and a table, with all of its columns or a chosen few.
- **Limits** (`zeteo.grants.read`, changes with `.write`): how many queries and exports a user or
  group may run at once, in place of the source's defaults.
- **Runs** (`zeteo.runs.read`): the record of every query and export, newest first, filtered by
  person, source or outcome; a run's details show the query as it was sent. It is read-only, and
  the UI has no query screen of its own. Searching for a person by name needs
  `zeteo.grants.read` too; without it the filter takes a pasted user id.
- **Saved queries** (`zeteo.saved_queries.read`, changes with `.write`): every user's saved queries
  in a table, filtered by name, owner, source or the person or group a query is shared with. A row
  shows the owner, the source, the share count and when it last ran; the share and transfer icons
  and Delete act on any of them. A saved query's JSON is never shown here, and the section has no
  edit: only the owner changes a saved query.
- **My Zeteo** (`/my`, `zeteo.data.read`), for everyone who may query; for a person with no admin
  section it is where they land. Its panels are the caller's own saved queries ("New saved query"
  takes a query's JSON; each card has **Share**, **Transfer**, **Edit details**, **View JSON** and
  **Delete**), the ones shared with them (**Copy to mine** and **View JSON**), their recent runs
  (**Show query**, and **Save as saved query**, which starts a saved query from a run's JSON), and
  "What I can query", the catalogue as `GET /v1/catalog` gives it. A saved query the person cannot
  run shows the notice "You need expanded permissions to run this saved query. Ask an admin to
  extend your access." and carries no query or source. Sharing searches people with
  `GET /v1/me/principals`. A run of a saved query that was refused shows "Query withheld".
  The UI has no button that runs a saved query; running and exporting are the API's and MCP's.
  With `zeteo.uploads.write`, while Uploads are on, My Zeteo has a **My sources** tab: the
  person's own upload sources (name, size, how many people and groups it is shared with, when it
  was added; Delete). **Add data** (`/my/data/new`)
  uploads a CSV or `.xlsx` file, or takes **any Google spreadsheet link** (when a Google
  connection is saved), and shows its preview before anything is created: the tables to
  keep, their names, the header row, and each column's name and type with sample values and the
  parse warnings; a value that does not fit its type names the column and rows. Leaving Add
  data, Add tables or Re-upload without creating discards the upload. Creating asks for a name,
  an optional slug and an optional description (at most 500 characters, as for a database
  source) and lands on the new source's page. An upload source's page (`/sources/<id>`, reached by its owner from My sources and
  by admins from Sources; its owner needs only `zeteo.uploads.write`) is the same page as a
  database source's (above). Its Tables list adds each table's rows and last load; a table's page adds
  **Re-upload**, remove and, per column, a dialog to rename or retype it (warning that saved
  queries using it may stop working); its header has **Add tables**, **Transfer**, **Edit** (its
  name, and its limits for `zeteo.sources.write`) and **Delete**; and Shared with lists the owner's own grant, marked and locked. A retype's values
  that do not fit name data rows of the table (an upload's name rows of the file). The owner
  manages it all; an admin's controls follow their permissions: tables, Edit, Transfer and
  Delete with `zeteo.sources.write`, which alone may change its limits; the Shared with tab with `zeteo.grants.read`, and
  sharing and changing grants with `zeteo.grants.write` (which may still remove grants once the
  source is deleted, when the owner grants are no longer locked).

- **Dashboards** (`/dashboards`, `zeteo.data.read`), for everyone who may query, after My Zeteo.
  Its tabs list the person's own dashboards and those shared with them, and their saved panels
  (`/saved-panels` goes to the Saved panels tab). A dashboard (`/dashboards/<id>`) shows its panels
  on a 12-column grid, runs them as the viewer with a time range picker, a refresh and an **Auto-refresh** picker ([dashboards.md](dashboards.md#auto-refresh-on-the-dashboard-page)), and the
  owner edits it: add, move, resize and remove panels, a panel editor with a chart form that
  checks the chart against the query's columns, **Save as saved panel**, **Detach**, **Share**,
  **Transfer** and **Copy**. A panel that cannot be shown carries the copy of
  [dashboards.md](dashboards.md#panel-states-and-their-copy) and nothing of the query. A saved query's
  **Available for dashboards** switch is in My Zeteo.
- **Display mode** (`/dashboards/<id>/display`): the dashboard alone, with no top bar, in its
  theme, refreshing itself and reloading the dashboard as it does; on a lost session it says
  "Signed out — sign in again on this screen" instead of redirecting ([dashboards.md](dashboards.md#display-mode)). A **Full screen** button
  appears in the corner while the mouse moves; an unattended screen should use the browser's kiosk mode, as full screen needs a click.
- **All dashboards** and **All saved panels** under Admin (`/admin/dashboards`, `/admin/saved-panels`,
  `zeteo.dashboards.read`; share, transfer and delete need `.write`): every user's dashboards and
  saved panels in a table filtered by name and owner. A row's panels, charts and queries are not
  shown here and the sections have no edit: only the owner changes one.

- **Measures** tab on a source (`/sources/<id>/measures`): name, table, description, used-by counts and a
  Broken pill with the server's message; rows an editor may not use show "Not usable by you" and no
  formula. `zeteo.measures.write`, for an editor of the source (the list's `can_edit`), adds New and
  Edit (a page of its own, `/sources/<id>/measures/new` and `/sources/<id>/measures/<measureId>/edit`:
  name, table, description, Fixed and date column on the left, JSON editors for `formula` and `where`
  on the right, the server's plan errors, the
  preview's included, shown under the field at their path, and Preview, which runs the draft and is
  cleared when the draft changes; renaming a measure that saved queries or panels use warns they
  will stop working) and Delete (confirmed with what uses it; refused with the measures that use
  it). A sources admin or an upload's owner also gets **Editors**, the users and groups who may
  manage the source's measures, and, while not an editor themselves, a hint to add themselves. The
  Date column select offers the home table's date and timestamp columns and its to-one relations'
  (changing the table clears it).
- **Metrics** tab on a source (`/sources/<id>/metrics`): metrics with the measures they use and
  their used-by counts, the same editors, Editors button and hint as Measures; New and Edit are
  pages (`/sources/<id>/metrics/new`, `…/metrics/<metricId>/edit`) with name and description on the
  left and the JSON formula on the right, live validation and Preview (a month-bucketed metric query
  over the last 12 months), and
  Delete is confirmed with what uses it and, when refused, shows the server's message and the
  measures or metrics that depend on it.
- **Calendar** under Admin (`/calendar`): working days, fiscal year start month and time zone on
  the left; on the right a table of holidays (date, weekday, name, remove), with **Add holidays**
  opening a dialog that takes them one row at a time or as pasted `date,name` lines (a date already
  listed is replaced); a year with none says so. Anyone who can query may open it, read-only; the
  menu lists it only to those with `zeteo.calendar.write` or `zeteo.sources.read`.
  `zeteo.calendar.write` changes it: **Save calendar**, top right, is enabled only while something
  differs from the saved calendar, and replaces the whole calendar.
- My Zeteo's catalogue lists each table's measures with their descriptions where the catalogue has them.

The top bar holds **My Zeteo** and **Dashboards** (`zeteo.data.read`), then an **Admin** menu that
lists the admin sections the person may see (Sources, Grants, Limits, Calendar, Runs, Saved queries,
Dashboards, Saved panels) and is absent when they may see none (so someone who can only query has
no Admin menu); it is marked active under any of
their paths. `/` lands on My Zeteo for anyone holding `zeteo.data.read`, admins included, and
otherwise on their first admin section. The sections are listed once, in `src/app/sections.tsx`.

The top bar's user menu signs out: the UI revokes its refresh token and ends Tereo's session, and
lands on `/signed-out`; the next sign-in asks for the password again.

**Live permissions.** The UI reads the person's permissions from `GET /v1/me` when it signs in and
again whenever Tereo reports that they changed (over the socket `liveEvents` opens) or a renewed
token arrives. A role granted or removed in Tereo therefore shows or hides sections within moments,
without a reload, and removing the last one turns the page into "No access". `GET /v1/me` reads
the permissions fresh from Tereo each time (zeteo drops its cached token introspection for that
route), so the answer after a change is never stale. zeteo itself decides each request from the
token it is sent, whatever the UI shows. The UI applies the same ladder as zeteo (`admin` covers
everything, `x.admin` everything under `x.`, and read < write < archive < delete within one area),
so it never hides a control zeteo would allow.

If the account cannot be loaded after signing in, the UI says so with zeteo's reason. If a stored
session cannot be renewed (Tereo or the network failed, rather than refusing it), it says the
session could not be restored, and **Try again** reloads the page.

## Development setup

In development the UI runs on its own dev server, on port 4200, and zeteo in development mode on
4201:

```sh
# packages/zeteo/.env: UI_CLIENT_ID=<the login client's id>, and UI_TEREO_URL if TEREO_URL is
# not the address a browser reaches Tereo at
cd packages/zeteo && npm run dev           # http://localhost:4201
npm run dev -w zeteo-ui                    # http://localhost:4200, from the root
```

The dev server forwards `/v1` and `/ui-config.json` to zeteo, so `/ui-config.json` answers only
with `UI_CLIENT_ID` set. The page calls Tereo from the dev server's origin, so:

- The login client's `redirectUris` include `http://localhost:4200/callback` and its
  `postLogoutRedirectUris` `http://localhost:4200/`.
- Tereo's `CORS_ALLOWED_ORIGINS` lists `http://localhost:4200`, for the code exchange and token
  renewal.
- zeteo's `CORS_ALLOWED_ORIGINS` lists it as well, for example
  `CORS_ALLOWED_ORIGINS=http://localhost:4201,http://localhost:4200` (the value replaces the
  default, `PUBLIC_URL`'s origin, so list that too if you still need it).

Open the UI as `http://localhost:4200` (or `127.0.0.1`), or over https. Sign-in uses PKCE, whose
hash comes from the browser's `crypto.subtle`, which browsers offer only in a secure context:
https, or `localhost` and loopback addresses over plain http. Opened over plain http under any
other host name (a LAN address, a container name), the page says sign-in needs https and stops.

The root `docker-compose.yml` runs zeteo in test mode, with no Tereo to sign in to; its zeteo
service lists the two UI variables, commented out, for a stack that has one.

## Reserved paths and the content security policy

The UI may not use these prefixes, which zeteo answers itself: `/v1`, `/health`, `/mcp`,
`/.well-known`, `/assets` and `/ui-config.json`. The UI's routes include `/dashboards`, `/dashboards/<id>`,
`/dashboards/<id>/display`, `/saved-panels` and `/admin/dashboards`, all clear of them. Any other path that is not a file of the build
gets the UI's `index.html`. Page routes whose last path segment contains a dot (`/sources/a.b`)
are not answered by the app shell: they are taken for files and answer `404` when the build has no
such file, so the UI must not give its routes such segments.

Every response, API included, carries a `Content-Security-Policy`:

```
default-src 'self'; script-src 'self'; connect-src 'self' <UI_TEREO_URL's origin>;
style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none';
frame-ancestors 'none'; form-action 'self'; base-uri 'self'
```

Tereo's origin is in `connect-src` only when `UI_CLIENT_ID` is set, and `upgrade-insecure-requests`
is added when `PUBLIC_URL` is https.

## The API

| Call | Permission | Returns |
|------|------------|---------|
| `GET /v1/me` | any signed-in caller | `{ id, type: "user" \| "service", name, email, permissions }`: the `zeteo.*` permissions held, sorted (plus a bare `admin`, which covers them all). `name` and `email` are `null` when Tereo does not answer within two seconds, so the permissions always come back |
| `GET /v1/principals?type=user\|group&q=&limit=` | `zeteo.grants.read` | `{ data: Principal[] }`: principals whose name (a user's email too) contains `q` |
| `GET /v1/principals/all` | `zeteo.grants.read` | `{ data: Principal[], truncated }`: every user (service accounts included) and every live group, by name, for the admin pages' "Who" filters |
| `POST /v1/principals/lookup` | `zeteo.grants.read` or `zeteo.runs.read`, or `zeteo.uploads.write` with `zeteo.data.read` (then only for principals granted on the caller's own upload sources, other ids answered `orphaned`, and counted against the search limit) | `{ data: Principal[] }` for `{ principals: [{ type, id }] }` (1 to 100), in order; an id Tereo does not know comes back `status: "orphaned"` with `null` names |
| `GET /v1/me/runs` | `zeteo.data.read` | the caller's own runs, as `GET /v1/runs` without `user_id` and `source_id` |
| `GET /v1/me/principals?type=user\|group&q=&limit=` | `zeteo.data.read` | `{ data: Principal[] }` as `GET /v1/principals`, for the sharing dialog: users (people only) and groups that are global or of the caller's organization |
| `GET /v1/me/principals/all` | `zeteo.data.read` | `{ data: Principal[], truncated }` as `GET /v1/principals/all`, over the people and groups `GET /v1/me/principals` searches; the "Who" filter of an upload source's owner |

**Connections** (`/connections`, in the Admin menu, `zeteo.sources.read`) shows the Google service
account's email (`GET /v1/connections/google`); **Set key**, which needs `zeteo.sources.write`, is
where an admin pastes the service-account JSON key (`PUT /v1/connections/google`). Only the
account's email is shown after it is saved. A source with Google Sheets tables shows its sync interval, when it last
attempted a sync, **Sync now** for its owner and admins (only when it has Sheets tables), a
**Sync failing** badge and **Stale** after 24 hours of failed syncs; its owner and `zeteo.sources.read`
see each table's sync error. Its Tables list has an **Origin** column: the file name, "spreadsheet · tab"
linking to the sheet, or "Merged · N tables". **Add tables** takes a file or any sheet link (re-upload is
for file tables only), and **Add merged table** opens the merged editor (members with their labels, the
label column, the columns to include); a merged table's page lists its members and shows warnings for
members that dropped out. The source's Overview lists its spreadsheets. Details:
[uploads.md](uploads.md#merged-tables).

The saved queries the UI manages are in [saved-queries.md](saved-queries.md), and Uploads in
[uploads.md](uploads.md).

A `Principal` is `{ type, id, name, email?, status }`, with `email` for users only and `status`
`active`, `inactive` or `orphaned`.

Search limits: `q` is 2 to 100 characters, `limit` 1 to 25 (default 10), and a caller may search 60
times a minute across all replicas (`429` after that). Search finds people only: service accounts
are not in its results, and are found by id through `lookup`.

The two `/all` calls read the whole directory from Tereo on every call, page by page (200 users
or 100 groups a page), at most 5000 users and 5000 groups: past either, the answer has the first
5000 and `truncated: true`. They are sorted by name, case-insensitively, a principal without a
name last. Each counts as one search against the 60 a minute, takes no query parameters, waits
on Tereo for at most 20 seconds, and is never cached by zeteo; the UI keeps its answer for five
minutes.

When zeteo cannot reach Tereo's directory, these calls answer `502 tereo_unreachable`. A search
or a lookup waits on Tereo for at most five seconds in all, retries included; past that it is
`502 tereo_unreachable` too, never a partial answer and never `orphaned`. (`GET /v1/me` stops
waiting for the name at two seconds and answers without it.)

Lookup reads each group from Tereo on its own, at most eight at a time, and caches a group's
name and status in Redis for 60 seconds (users are not cached). A group renamed or archived in
Tereo can therefore show its old name or status for up to a minute.

The SDK has the same calls: `zeteo.me.get()`, `zeteo.me.allPrincipals()`,
`zeteo.principals.search()`, `zeteo.principals.all()` and `zeteo.principals.lookup()`.

## Privacy

Holders of `zeteo.grants.read` or `zeteo.runs.read` can read the name and email of any Tereo user,
not only of users with grants in zeteo: search and lookup go to Tereo's directory with zeteo's
service account. Give those permissions accordingly.

Known limitation. zeteo's own log lines never carry the search text, a name or an email. The
request handler underneath (`@dianemo/core`, reached through `@tereo-io/sdk`) logs a failed request
to Tereo (a 5xx, a 429, a timeout, a dropped connection) with its parameters, so during a Tereo
outage a search fragment can appear in zeteo's error log. It also logs Tereo's 4xx answers with
their parameters at debug level, and a request zeteo abandons at the five-second directory budget
may be logged with its parameters as well. The current versions have no option to suppress it.
