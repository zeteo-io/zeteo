# Admin UI

The admin UI is a web page served from zeteo's own origin. Its build (`packages/zeteo-ui`) ships
in zeteo's image, and zeteo serves it at `/` once `UI_CLIENT_ID` names its login client in Tereo;
without `UI_CLIENT_ID` the image runs as an API only and `/` is a JSON `404`. This document covers
turning it on, what each screen does, local development, and what zeteo provides for it:
`GET /v1/me`, `GET /v1/principals`, `POST /v1/principals/lookup`, the public `GET /ui-config.json`,
a content security policy on every response, and the serving of the build. The server side is
exercised end to end by `e2e/tests/me.e2e.test.ts`, `directory.e2e.test.ts` and
`uiSignIn.e2e.test.ts`, and the UI itself in Chromium by `e2e/browser/admin.spec.ts`.

## Turning it on

| Variable | Default | Meaning |
|----------|---------|---------|
| `UI_CLIENT_ID` | unset (off) | The OAuth client id of the UI's login client in Tereo, 1 to 64 characters. Unset, the UI is not served and `/ui-config.json` answers `404` |
| `UI_TEREO_URL` | `TEREO_URL` | The Tereo URL the browser calls. It is published to browsers at `/ui-config.json`. It must be `https` when `PUBLIC_URL` is `https` (a page served over https cannot call an http origin: browsers block mixed content); under an `http` `PUBLIC_URL` an `http` URL is accepted, in production too. It may carry no credentials, query or fragment. Set it whenever `TEREO_URL` is an internal address |
| `UI_DIST_PATH` | `packages/zeteo-ui/dist` | The UI build to serve; a relative path resolves from `packages/zeteo`. Without an `index.html` there the UI is not served, and the start log says why |

`GET /ui-config.json` returns `{ "tereo_url": "...", "client_id": "..." }`, needs no sign-in and
answers whenever `UI_CLIENT_ID` is set, build or not.

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
  status. A new source takes its connection (host, port, database, login, TLS mode and an optional
  CA certificate), its schemas and its limits. A source's page runs **Test** (does the login hold
  rights a read-only one would not), **Refresh** (reads the catalogue again and says what changed),
  edits and archives it.
- **Tables** and **Relations**, tabs of a source: the catalogue as zeteo last read it. A table's
  page shows its columns and relations and edits the table's and columns' descriptions; Relations
  lists the relations read from the database and declares or removes the ones it lacks.
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

- **Dashboards** (`/dashboards`, `zeteo.data.read`), for everyone who may query, after My Zeteo.
  Its tabs list the person's own dashboards and those shared with them, and their saved panels
  (`/saved-panels` goes to the Saved panels tab). A dashboard (`/dashboards/<id>`) shows its panels
  on a 12-column grid, runs them as the viewer with a time range picker and a refresh, and the
  owner edits it: add, move, resize and remove panels, a panel editor with a chart form that
  checks the chart against the query's columns, **Save as saved panel**, **Detach**, **Share**,
  **Transfer** and **Copy**. A panel that cannot be shown carries the copy of
  [dashboards.md](dashboards.md#panel-states-and-their-copy) and nothing of the query. A saved query's
  **Available for dashboards** switch is in My Zeteo.
- **Display mode** (`/dashboards/<id>/display`): the dashboard alone, with no top bar, in its
  theme, refreshing itself; on a lost session it says "Signed out - sign in again on this screen"
  instead of redirecting ([dashboards.md](dashboards.md#display-mode)).
- **Dashboards (all)** and **Saved panels (all)** (`/admin/dashboards`, `/admin/saved-panels`,
  `zeteo.dashboards.read`; share, transfer and delete need `.write`): every user's dashboards and
  saved panels in a table filtered by name and owner. A row's panels, charts and queries are not
  shown here and the sections have no edit: only the owner changes one.

The top bar's menu signs out: the UI revokes its refresh token and ends Tereo's session, and
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
| `POST /v1/principals/lookup` | `zeteo.grants.read` or `zeteo.runs.read` | `{ data: Principal[] }` for `{ principals: [{ type, id }] }` (1 to 100), in order; an id Tereo does not know comes back `status: "orphaned"` with `null` names |
| `GET /v1/me/runs` | `zeteo.data.read` | the caller's own runs, as `GET /v1/runs` without `user_id` and `source_id` |
| `GET /v1/me/principals?type=user\|group&q=&limit=` | `zeteo.data.read` | `{ data: Principal[] }` as `GET /v1/principals`, for the sharing dialog: users (people only) and groups that are global or of the caller's organization |

The saved queries the UI manages are in [saved-queries.md](saved-queries.md).

A `Principal` is `{ type, id, name, email?, status }`, with `email` for users only and `status`
`active`, `inactive` or `orphaned`.

Search limits: `q` is 2 to 100 characters, `limit` 1 to 25 (default 10), and a caller may search 60
times a minute across all replicas (`429` after that). Search finds people only: service accounts
are not in its results, and are found by id through `lookup`.

When zeteo cannot reach Tereo's directory, these calls answer `502 tereo_unreachable`. A search
or a lookup waits on Tereo for at most five seconds in all, retries included; past that it is
`502 tereo_unreachable` too, never a partial answer and never `orphaned`. (`GET /v1/me` stops
waiting for the name at two seconds and answers without it.)

Lookup reads each group from Tereo on its own, at most eight at a time, and caches a group's
name and status in Redis for 60 seconds (users are not cached). A group renamed or archived in
Tereo can therefore show its old name or status for up to a minute.

The SDK has the same calls: `zeteo.me.get()`, `zeteo.principals.search()` and
`zeteo.principals.lookup()`.

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
