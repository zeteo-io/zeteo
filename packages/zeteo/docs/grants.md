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
