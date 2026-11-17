# Saved queries

A saved query is a query a user keeps under a name, to run again and to share. It is the JSON of
`POST /v1/query` ([querying.md](querying.md)) with a name and a description, owned by one user (or
service account). The reference is `openapi/openapi.yaml`; the SDK has the same calls under
`zeteo.savedQueries`.

A saved query holds no result and no permission of its own. Whoever runs it is planned as
themselves, against their own and their groups' grants ([grants.md](grants.md)), so a share never
widens anyone's access to data.

| Route | Permission | Result |
|-------|------------|--------|
| `GET /v1/saved-queries?scope=mine\|shared\|all` | `zeteo.data.read` (`all`: `zeteo.saved_queries.read`) | `{ data, next_cursor }` |
| `POST /v1/saved-queries` | `zeteo.data.read` | `201`, the saved query |
| `GET /v1/saved-queries/{id}` | `zeteo.data.read` | the saved query |
| `PATCH /v1/saved-queries/{id}` | `zeteo.data.read` | the saved query; the owner's own only |
| `DELETE /v1/saved-queries/{id}` | `zeteo.data.read` | `204`; the owner, or `zeteo.saved_queries.write` |
| `POST /v1/saved-queries/{id}/run` | `zeteo.data.read` | as `POST /v1/query` |
| `POST /v1/saved-queries/{id}/export?format=ndjson\|csv` | `zeteo.data.export` | as `POST /v1/export` |
| `POST /v1/saved-queries/{id}/copy` | `zeteo.data.read` | `201`, the caller's own copy |
| `GET /v1/saved-queries/{id}/shares` | `zeteo.data.read` | the shares; the owner, or `zeteo.saved_queries.read` |
| `PUT /v1/saved-queries/{id}/shares` | `zeteo.data.read` | the whole share list, replaced; the owner, or `zeteo.saved_queries.write` |
| `POST /v1/saved-queries/{id}/transfer` | `zeteo.data.read` | the saved query under its new owner; the owner, or `zeteo.saved_queries.write` |
| `GET /v1/me/runs` | `zeteo.data.read` | the caller's own runs, as `GET /v1/runs` |
| `GET /v1/me/principals` | `zeteo.data.read` | people search for sharing |

## Permissions

`zeteo.saved_queries.read` lists and reads every saved query and its shares, whoever owns it
(`scope=all`), and lets the holder look up users' names and email addresses. `zeteo.saved_queries.write`
includes it and also shares, transfers and deletes any saved query. Neither is organization-assignable,
and both are in `zeteo_admin`. An ordinary user needs only `zeteo.data.read`, which gives them their own
saved queries and those shared with them.

Changing the query, name or description is the owner's alone: a holder of `zeteo.saved_queries.write`
gets `not_found` from `PATCH`, as anyone else does. An admin who may see a saved query but not change it
(`zeteo.saved_queries.read` alone, asking for a share change) gets `403 forbidden`; anyone who may not
see it at all gets the one `404 not_found`.

## What a saved query holds

- `name`: trimmed, 1 to 100 characters, unique per owner whatever the case (`409 conflict`).
- `description`: 0 to 2,000 characters, default empty.
- `query`: an object, at most 256 KB, in the source's language. The source is the one the query names;
  the saved query keeps its id, so renaming the source's slug does not break it.

Saving or changing a query plans it against the caller's own grants, exactly as `POST /v1/query`
does, so a bad query is refused with the same error and detail (`400`, `422`). It is the caller's own
query. A saved query is not run when it is saved.

## The view

`GET` and the other calls return `{ id, name, description, owner: { id, name }, accessible, created_at,
updated_at, shared_at?, last_run_at, you_last_ran_at, source?, query?, share_count? }`.

- `accessible` says whether the viewer can run it now: its source is visible and not archived and its
  JSON plans against what they are granted. No cause is told apart (an ungranted column or table, a
  relation not visible, an archived source, no grant on the source and a column now `missing` all read
  alike).
- `source` (`{ id, slug }`) and `query` are present only when `accessible` is true. They are left out,
  not null, otherwise. A holder of `zeteo.sources.read` also sees `source` when `accessible` is false,
  but never `query`.
- `shared_at` is when it was last shared with the viewer, on `scope=shared`.
- `last_run_at` and `you_last_ran_at` are the last successful run by anyone and by the viewer.
- `share_count` is given where the viewer may see the share list: its owner, or a holder of
  `zeteo.saved_queries.read`.

A saved query whose owner has lost access still shows under `scope=mine` with `accessible: false`;
the owner can rename, share, transfer and delete it, but not run it.

## Listing

`scope=mine` (the default) lists the caller's own, `shared` those shared with them directly or through
a group of theirs, and `all` every one, for `zeteo.saved_queries.read`. `q` matches names (case-insensitive, anywhere in the name). On `scope=all` only, `owner_id`, `source_id` (needs `zeteo.sources.read`) and
`shared_with_type` with `shared_with_id` filter further. `limit` is 1 to 100 (default 50), paged by
`cursor`.

## Running and exporting

`POST .../run` and `POST .../export` run the stored query as the caller, with the same checks, limits,
leases and recording as `POST /v1/query` and `POST /v1/export`. The body may give `limit` and `offset`
to replace the stored ones (`limit` at least 1, `offset` 0 up to the language's maximum); no body runs
it as stored. An export also needs `zeteo.data.export` and the source's export switch
([export.md](export.md)).

A caller who cannot run it, whatever the cause, gets `403 saved_query_not_accessible` with the message
`You need expanded permissions to run this saved query. Ask an admin to extend your access.` The body
carries no query, source, path or suggestion, and it is the same for every cause. An export is refused
this way before its first byte, also when exports are disabled on a source the caller cannot see, so
`export_not_enabled` never reveals a source. A saved query that is not the caller's to see is
`404 not_found`.

A successful run sets `last_run_at` and the runner's own `you_last_ran_at`.

## Copying

`POST .../copy` with `{ name }` gives the caller their own copy of a saved query they can see and run,
with no shares; a saved query they cannot run is `saved_query_not_accessible`.

## Sharing

`PUT .../shares` with `{ principals: [{ type: "user" | "group", id }] }` (at most 100, each once, the
owner not among them) makes the list exactly that. Sharing gives the right to see and run the saved
query, never data access: a recipient who lacks grants sees it with `accessible: false` and the notice
above. The response is `{ data, warnings }`; `data` lists the shares with names (and emails for users),
and `warnings` has `{ type: "user", id, accessible: false }` for each newly added user who could not run
it now, judged as if signed in to the sharer's organization. Groups are never warned about.

A group must be global or belong to the sharer's signed-in organization (`400 invalid_share` otherwise); one already
shared is not checked again. User shares are not limited by organization, because Tereo users have
none. A service account can be shared with by id. A change that races another is `409 conflict`; load
the shares again and retry.

## Transferring

`POST .../transfer` with `{ user_id, keep_access }` (default true) makes `user_id` the owner. With
`keep_access` the previous owner keeps a direct share. The target cannot be a service account, an unknown user or the current owner (`400 invalid_transfer`), and the new owner must not already have a saved query of that name
(`409`). The response is `{ data, warning? }`, with `warning: { accessible: false }` when the new owner
could not run it.

## Own runs

`GET /v1/me/runs` is `GET /v1/runs` for the caller alone: the same row, `outcome` filter and cursor,
without `user_id` and `source_id`. A run of a saved query carries `saved_query: { id, name }` while the
caller owns it or it is shared with them; the key is left out otherwise. Rows are `Cache-Control:
no-store`.

`GET /v1/me/principals?type=user|group&q=&limit=` is the search the sharing dialog uses: as
`GET /v1/principals` ([admin-ui.md](admin-ui.md#the-api)) but open to `zeteo.data.read`, listing human
users, and groups that are global or of the caller's organization.

## What is recorded

Creating, changing, deleting, sharing, transferring and copying write audit entries
(`zeteo.saved_query.created`, `.updated`, `.deleted`, `.shared`, `.transferred`, `.copied`), whose
metadata carries names and ids and never the query. Running or exporting records a run as any query
does ([querying.md](querying.md#the-run-log)), with the saved query's id. A run refused as
`saved_query_not_accessible` is recorded with the query `{ "withheld": true }` and a null `source_id`,
so the caller's own runs cannot show what the refusal withholds.

Deleting a saved query removes its shares and per-user run times; its recorded runs stay, no longer
naming it.

## MCP

The tools of [mcp.md](mcp.md#the-tools) list, read, run, create, change and delete saved queries. They
change the caller's own only, and sharing and transferring are done in the UI or the API.
