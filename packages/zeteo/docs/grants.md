# Grants

A grant gives one Tereo user or group the right to query one table. The admin API is under
`/v1/grants` (the reference is `openapi/openapi.yaml`). Access is default deny: a table with no
grant is invisible to everyone.

| Route | Permission | Result |
|-------|------------|--------|
| `GET /v1/grants` (`principal_type`, `principal_id`, `table_id`, `source_id`, `limit`, `cursor`) | `zeteo.grants.read` | `{ data, next_cursor }` |
| `POST /v1/grants` | `zeteo.grants.write` | `201`, the grant |
| `GET /v1/grants/:grantId` | `zeteo.grants.read` | the grant |
| `PUT /v1/grants/:grantId` | `zeteo.grants.write` | the grant |
| `DELETE /v1/grants/:grantId` | `zeteo.grants.write` | `204` |

`write` includes `read`. A caller without the permission gets `403 forbidden` before the body is
validated. Both permissions are for administrators and are never assignable through an
organization.

## The grant

`{ id, principal_type, principal_id, principal_status, source: { id, slug }, table: { id,
schema_name, name, missing }, all_columns, columns: [{ id, name, missing }], created_by,
created_at, updated_at }`.

- `principal_type` is `user` or `group`; `principal_id` is the Tereo id. A grant does not need its
  principal to exist when it is created, and a user's id and a group's id with the same value are
  different principals.
- A principal has at most one grant per table (`409 grant_exists`); change its columns with `PUT`.
- Create takes `{ principal_type, principal_id, table_id, all_columns: true }` or the same with
  `all_columns: false` and `column_ids`, 1 to 500 distinct ids of columns of that table
  (`422 invalid_grant` for any that is not, including an id that does not exist at all).
- `PUT` takes only the columns half (`{ all_columns: true }` or `{ all_columns: false,
  column_ids }`) and replaces it whole. The principal and the table never change.
- Unknown `table_id` is `404 not_found`. A table of an archived source takes no new grant and no
  change to a grant (`409 source_archived`); removing one still works.
- `columns` lists the granted columns in table order, empty when `all_columns` is true.
- Each create, replace and removal writes one audit entry (`zeteo.grant.created`,
  `zeteo.grant.updated`, `zeteo.grant.removed`) in the same transaction, with
  `{ source_id, table_id, principal_type, principal_id, all_columns, column_ids }` as metadata. A
  refused request writes none.

## Rules

- **Default deny.** A newly found table has no grants.
- **Grants add up.** A user's access is the union of their own grants and those of every group they
  are in (global groups, and those of the organization the token was issued for). There are no deny
  rules.
- **New columns stay hidden on explicit grants.** A grant with a column list does not include
  columns added later. An `all_columns` grant does.
- **Drift is tracked, not destructive.** A table or column the last refresh did not find is shown
  with `missing: true`; queries naming it fail clearly and the grant keeps it, so the access returns
  when the column does.
- **A view is granted as itself.** A grant on a view exposes what the view exposes.
- **A relation is usable only when every key column on both sides is granted.**

## Principal statuses

`principal_status` says whether Tereo still knows the principal. It is looked up when a grant is
shown (once per distinct principal in a list), never stored.

| Status | Meaning |
|--------|---------|
| `active` | Tereo knows the user or group |
| `orphaned` | A user Tereo no longer has. The grant is inert and stays until an admin removes it |
| `unknown` | A group Tereo refused to confirm or has no record of: group existence cannot be read with the permissions a service can request, so a group is `active` or `unknown`, never `orphaned`. Also shown when the lookup itself failed |

A failed lookup is logged and shown as `unknown`; it never fails the request, since the grant itself
was read or changed.

With today's Tereo a service cannot read groups at all, so in production a group grant's
`principal_status` is always `unknown`, never `active`. It only reports; a group grant counts for its
members whatever its status.

## Concurrency limits

Each user may run `USER_QUERY_CONCURRENCY` queries and `USER_EXPORT_CONCURRENCY` exports at once
([querying.md](querying.md#limits)). An administrator can give a user (a service account included)
or a group its own limits instead, under the same permissions as grants:

| Route | Permission | Result |
|-------|------------|--------|
| `GET /v1/principal-limits` (`principal_type`, `principal_id`, `limit`, `cursor`) | `zeteo.grants.read` | `{ data, next_cursor }` |
| `POST /v1/principal-limits` | `zeteo.grants.write` | `201`, the row |
| `GET /v1/principal-limits/:principalLimitId` | `zeteo.grants.read` | the row |
| `PATCH /v1/principal-limits/:principalLimitId` | `zeteo.grants.write` | the row |
| `DELETE /v1/principal-limits/:principalLimitId` | `zeteo.grants.write` | `204` |

The row: `{ id, principal_type, principal_id, principal_status, query_concurrency,
export_concurrency, created_by, created_at, updated_at }`, with `principal_status` as for a grant
([below](#principal-statuses)) and a limit the row does not set shown as `null`.

- Create takes `{ principal_type, principal_id, query_concurrency?, export_concurrency? }` with at
  least one limit: `query_concurrency` 1 to 100, `export_concurrency` 1 to 10 (`400
  invalid_request` otherwise). A principal has at most one row (`409 conflict`). Like a grant, a
  row does not need its principal to exist; a row for a principal Tereo does not know is inert.
- `PATCH` takes either limit or both; `null` clears one. A change that would leave neither set is
  `400 invalid_request`: remove the row instead. The principal never changes.
- Each create, change and removal writes one audit entry (`zeteo.principal_limit.created`,
  `zeteo.principal_limit.updated`, `zeteo.principal_limit.removed`) in the same transaction, with
  `{ principal_type, principal_id, query_concurrency, export_concurrency }` as metadata and, on a
  change, the values before it under `previous`. A refused request writes none.

Which limit applies is decided for each limit apart, as each query or export starts: the user's own
row if it sets that limit; otherwise the highest value among the rows of the groups that count for
the user (the same groups as for grants); otherwise the environment's default. A group's row
replaces the default even when it is lower. A change applies to the runs that start after it.
