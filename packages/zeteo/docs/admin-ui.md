# Admin UI: the server side

The admin UI is a web page served from zeteo's own origin. This document covers what zeteo
provides for it; the UI package itself is not in the image yet, so `/` is still a JSON `404`
until it is. What exists today: `GET /v1/me`, `GET /v1/principals`, `POST /v1/principals/lookup`,
the public `GET /ui-config.json`, a content security policy on every response, and the code that
serves a UI build at `/` once one is present. Everything below is exercised end to end by
`e2e/tests/me.e2e.test.ts`, `directory.e2e.test.ts` and `uiSignIn.e2e.test.ts`.

## Turning it on

| Variable | Default | Meaning |
|----------|---------|---------|
| `UI_CLIENT_ID` | unset (off) | The OAuth client id of the UI's login client in Tereo, 1 to 64 characters. Unset, the UI is not served and `/ui-config.json` answers `404` |
| `UI_TEREO_URL` | `TEREO_URL` | The Tereo URL the browser calls. It is published to browsers at `/ui-config.json`. In production it must be `https`, and it may carry no credentials, query or fragment. Set it whenever `TEREO_URL` is an internal address |
| `UI_DIST_PATH` | `packages/zeteo-ui/dist` | The UI build to serve; a relative path resolves from `packages/zeteo`. Without an `index.html` there the UI is not served, and the start log says why |

`GET /ui-config.json` returns `{ "tereo_url": "...", "client_id": "..." }`, needs no sign-in and
answers whenever `UI_CLIENT_ID` is set, build or not.

## The login client in Tereo

The UI signs in with the authorization code flow and PKCE, as a public client, and keeps its
tokens in memory. A deploy declares the client in a provisioning document of Tereo
(`PROVISIONING_PATH`), next to zeteo's own:

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
      "consentRequired": false
    }
  ]
}
```

`clientId` is the value of `UI_CLIENT_ID`; `audience: ["zeteo"]` is what makes zeteo accept the
token. Tereo's `CORS_ALLOWED_ORIGINS` must list zeteo's public origin
(`https://zeteo.example.com`): the browser exchanges its code and renews its token at Tereo from
that origin, and without the entry it cannot do either.

## Reserved paths and the content security policy

The UI may not use these prefixes, which zeteo answers itself: `/v1`, `/health`, `/mcp`,
`/.well-known`, `/assets` and `/ui-config.json`. Any other path that is not a file of the build
gets the UI's `index.html`.

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

A `Principal` is `{ type, id, name, email?, status }`, with `email` for users only and `status`
`active`, `inactive` or `orphaned`.

Search limits: `q` is 2 to 100 characters, `limit` 1 to 25 (default 10), and a caller may search 60
times a minute across all replicas (`429` after that). Search finds people only: service accounts
are not in its results, and are found by id through `lookup`.

When zeteo cannot reach Tereo's directory, these calls answer `502 tereo_unreachable`.

The SDK has the same calls: `zeteo.me.get()`, `zeteo.principals.search()` and
`zeteo.principals.lookup()`.

## Privacy

Holders of `zeteo.grants.read` or `zeteo.runs.read` can read the name and email of any Tereo user,
not only of users with grants in zeteo: search and lookup go to Tereo's directory with zeteo's
service account. Give those permissions accordingly.

Known limitation. zeteo's own log lines never carry the search text, a name or an email. The
request handler underneath (`@dianemo/core`, reached through `@tereo-io/sdk`) logs a failed request
to Tereo (a 5xx, a 429, a timeout, a dropped connection) with its parameters, so during a Tereo
outage a search fragment can appear in zeteo's error log. The current versions have no option to
suppress it.
