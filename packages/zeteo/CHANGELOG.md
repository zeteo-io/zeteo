## 0.1.0 (2026-11-13)

### ⚠️  Breaking Changes

- Adds the streaming export (`POST /v1/export`, NDJSON or CSV, gzip, up to a source's export cap), per-source and per-user concurrency limits with per-user and per-group overrides (`/v1/principal-limits`), a housekeeping job for the run log, and an MCP endpoint (`/mcp`) with four read-only tools for an AI signed in through tereo. ([#1](https://github.com/zeteo-io/zeteo/pull/1))

  What a deployer must do or know:

  - **Tereo provisioning.** Apply the new `tereo-provisioning.json` to tereo: it declares the permissions `zeteo.data.export` (export; held by `zeteo_admin`) and `zeteo.mcp.use` (use zeteo over MCP), and the role `zeteo_mcp_user` (`zeteo.data.read` and `zeteo.mcp.use`), plus the audit events `zeteo.export.started`, `zeteo.export.run` and `zeteo.principal_limit.created|updated|removed`.
  - **Migrations.** Three, all additive: the run outcome `running` (an export in progress); `query_concurrency` (default 5) and `export_concurrency` (default 2) on every source; the `principal_limits` table.
  - **Retention.** The run log is now pruned: within two minutes of the first start, and hourly after, runs older than `QUERY_RUNS_RETENTION_DAYS` (default 90) are deleted, without audit entries (tereo's audit log keeps every run's entry). Set it to 0 before upgrading to keep everything.
  - **New environment variables**, all optional: `QUERY_RUNS_RETENTION_DAYS` (90), `USER_QUERY_CONCURRENCY` (5 queries at once per user), `USER_EXPORT_CONCURRENCY` (1 export at once per user), `MCP_ALLOWED_CLIENTS` (empty: MCP off), `MCP_ALLOWED_ORIGINS` (empty), `MCP_RATE_LIMIT_PER_MINUTE` (120). With MCP on, `PUBLIC_URL` must be zeteo's public https origin, and zeteo does not start while tereo is unreachable.
  - **Pool sizing.** Each replica opens up to `query_concurrency + export_concurrency + 2` connections per source (9 with the defaults). The source database must allow that many per zeteo replica on top of its other clients; lower a source's concurrency settings if it cannot.
  - **Exports** are off for every source until an administrator sets `export_enabled` and an `export_row_cap` above 0. A deploy stops running exports at once (recorded `shutting_down`); clients retry.

- Adds grants of tables and columns to users and groups, the catalogue of what a caller may query, the SQL query language and `POST /v1/query` with its run log, and Azure SQL sources next to Postgres. ([#1](https://github.com/zeteo-io/zeteo/pull/1))
- Moves zeteo onto Tereo core 0.8.1, `@tereo-io/sdk` 0.5.2 and `@tereo-io/mcp` 0.1.1. A group grant's or group limits row's `principal_status` is now `active`, or `orphaned` for a group Tereo does not have, instead of always `unknown`. ([#1](https://github.com/zeteo-io/zeteo/pull/1))

  What a deployer must do or know:

  - **Tereo 0.8.1 or later.** The new `tereo-provisioning.json` requests the core role `group_resolver`, which Tereo 0.8.0 does not have: applied there, the whole provisioning set fails. Upgrade Tereo first, then apply the document.
  - **What `group_resolver` reaches.** It grants `groups.read`, read-only access to every group, global and in every organization: zeteo's service account can list and search them, read each one's roles, its members' names, emails and active flag, and its SCIM skipped members' names and emails, and it can receive `auth.group.*` webhook events. Zeteo itself only reads a group by id, to report its status.

- Adds the sources admin API, the catalogue refresh that reads a source's tables, columns and foreign keys, and the relations and descriptions API on top of it. ([#1](https://github.com/zeteo-io/zeteo/pull/1))

### ❤️ Thank You

- Aaron Leman