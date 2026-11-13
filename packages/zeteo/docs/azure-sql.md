# Azure SQL sources

A source of type `azure-sql` is an Azure SQL Database, or any SQL Server 2017 or newer reached over
TCP. Zeteo connects, checks that the login is read-only, reads the listed schemas into the
catalogue ([catalog.md](catalog.md)), and runs queries in the same language, with the same results,
as on Postgres ([querying.md](querying.md)). Buckets use `DATETRUNC`, so the server must be SQL
Server 2022 or Azure SQL Database (or Managed Instance) for bucketed queries.

Everything in [sources.md](sources.md) (creating, changing, the override, pools, the network rules,
audit) applies; this page covers what is particular to this type.

## Settings

```json
{
  "host": "sales.database.windows.net",
  "port": 1433,
  "database": "sales",
  "user": "zeteo_reader",
  "password": "...",
  "tls": "verify"
}
```

- `port` defaults to 1433. `host` is a name or an address; a named instance (`host\instance`) is
  refused, because the driver would find its port by asking the host over UDP. Give the port.
- `tls` is `verify` (the default: the certificate is checked against `host`) or
  `trust-server-certificate` (encrypted, certificate not checked; for a server with a self-signed
  certificate). The connection is always encrypted; there is no unencrypted mode. With `verify`,
  give a hostname the certificate names, not an address.
- `password` must not be empty; it is encrypted at rest and never returned or audited. The API
  shows, and audit entries record, `host`, `port`, `database`, `user` and `tls`, so moving to
  `trust-server-certificate` is on the record.
- Only SQL authentication (a user name and password). Microsoft Entra sign-in (passwords, service
  principals, managed identities, tokens) and Windows authentication are not supported. Unknown keys
  are refused.

The connection goes to the address the network rules approved ([sources.md](sources.md), *Network
allowlist*): zeteo resolves `host` once, checks it, and dials that address itself; the driver never
resolves the name. The name is still what the login packet and the certificate check use.

**Connection policy.** Azure SQL's `Redirect` connection policy answers the login by sending the
client on to another host and port, which no rule has checked. Zeteo refuses the redirect, and the
source fails as `source_unreachable`. Use the `Proxy` policy on the logical server (the default for
connections from outside Azure; `Default` means `Redirect` for connections from inside Azure).

Each request zeteo sends for a catalogue read or the login check is bounded by the query timeout
(15 s) and cancelled on the server when it runs past it. A catalogue read is one request; the login
check is several in turn, each with the full timeout, so the whole check can take longer.

## The read-only login

Create a contained user in the source database, or a login and a user, and give it read access and
nothing else:

```sql
-- In the source database (contained user; Azure SQL Database):
CREATE USER zeteo_reader WITH PASSWORD = '<a strong password>';
-- or, with a server login, in master then in the database:
--   CREATE LOGIN zeteo_reader WITH PASSWORD = '<a strong password>';
--   CREATE USER zeteo_reader FOR LOGIN zeteo_reader;

ALTER ROLE db_datareader ADD MEMBER zeteo_reader;
-- Narrower: SELECT on the schemas zeteo should see, instead of db_datareader.
--   GRANT SELECT ON SCHEMA::sales TO zeteo_reader;
-- A schema it must not read, even as db_datareader:
--   DENY SELECT ON SCHEMA::hr TO zeteo_reader;
```

The catalogue lists only the tables and views of the listed schemas the login can `SELECT` from.

## What the login check refuses

The check covers the whole connected database, not just the listed schemas. It asks the server for
the login's effective rights (`HAS_PERMS_BY_NAME`, `fn_my_permissions`, `IS_ROLEMEMBER`,
`IS_SRVROLEMEMBER`), which follow role membership, nested roles and group membership, and `DENY`.
It does not read server-level catalogs, which an Azure SQL Database login usually cannot see:
server-level rights are probed one by one.

| Code | Found when the login (or a role it belongs to) |
|------|-------------|
| `superuser` | is in `sysadmin` or `db_owner`, or holds `CONTROL SERVER`, `IMPERSONATE ANY LOGIN` or `CONTROL` on the database. The check stops there. |
| `owns_objects` | is the database owner (it runs as `dbo`), owns a schema, a role or an application role, or was made owner of a table, view or procedure |
| `can_write_tables` | holds `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CONTROL` or `TAKE OWNERSHIP` on a table, view or schema, `UPDATE` on some columns, `EXECUTE` on a procedure or schema, or any other database permission that changes the database (`db_datawriter` and `db_ddladmin` among them) |
| `can_create_in_schema` | may create objects (`CREATE TABLE`, `CREATE VIEW`, `CREATE PROCEDURE`, …) or schemas, or holds `ALTER ANY SCHEMA` |
| `can_create_roles` | may manage principals: `ALTER ANY USER`, `ALTER ANY ROLE`, `ALTER ANY APPLICATION ROLE`, `CREATE USER`/`ROLE`, `ALTER ANY LOGIN`, `ALTER ANY SERVER ROLE`, or `securityadmin` / `##MS_LoginManager##`; or holds `ALTER`, `CONTROL` or `TAKE OWNERSHIP` on a role or application role (it could add itself to the role, or activate it), or `ALTER`/`CONTROL` on another user or login |
| `can_create_databases` | holds `CREATE ANY DATABASE` or `ALTER ANY DATABASE`, or is in `dbcreator` / `##MS_DatabaseManager##` |
| `bypasses_row_security` | holds `ALTER ANY SECURITY POLICY` or `ALTER ANY MASK` |
| `reads_server_files` | holds `ADMINISTER BULK OPERATIONS` or `ADMINISTER DATABASE BULK OPERATIONS`, or is in `bulkadmin` |
| `replication` | holds `CONNECT REPLICATION` |
| `write_role_member` | is in a fixed database role that writes (`db_owner`, `db_datawriter`, `db_ddladmin`, `db_securityadmin`, `db_accessadmin`, `db_backupoperator`) or a role holding a write right (the detail names it); is in `serveradmin`, `setupadmin`, `processadmin`, `diskadmin` or `##MS_ServerStateManager##`; holds another server permission that changes the server (`ALTER ANY CONNECTION`, `SHUTDOWN`, `ALTER SETTINGS`, …); or may `IMPERSONATE` another database user (`dbo` included) or login, and so act with its rights |

Connecting and viewing never count: `CONNECT`, `SELECT`, `REFERENCES`, `SHOWPLAN`, `UNMASK`,
`VIEW DEFINITION`, the `VIEW … STATE` permissions and the like. A database-wide right is reported
once for the database, not again for every schema and object.

Rights over principals are found although a low-privilege login sees few principals: SQL Server
shows a login the users, roles and logins it holds a permission on or owns (checked against SQL
Server 2022 for `IMPERSONATE` on a user and on a login, `ALTER` on a role and on an application
role, and an owned role). Logins are read from `sys.server_principals`; where a source does not let
the login read it, that part is skipped and the database-level checks stand.

A login that can create databases through the `dbmanager` role of Azure SQL's `master` database is
not seen from the source database. Do not give the reader login that role.

## Types

| SQL Server type | Catalogue type |
|-----------------|----------------|
| `char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext`, `uniqueidentifier`, `xml` | `text` |
| `tinyint`, `smallint`, `int`, `bigint`, `decimal`, `numeric`, `money`, `smallmoney`, `float`, `real` | `number` |
| `bit` | `boolean` |
| `date` | `date` |
| `datetime`, `datetime2`, `smalldatetime`, `datetimeoffset` | `timestamp` |
| `time` and anything else (`binary`, `varbinary`, `rowversion`, `sql_variant`, `geography`, `hierarchyid`, …) | `other` |

An alias type maps through its base type (`sysname` is `nvarchar(128)`), including one the login
has no right on. The catalogue's `native_type` is the type as SQL Server
writes it: `nvarchar(100)`, `nvarchar(max)`, `decimal(12,2)`, `datetime2(3)`.

Schema names match exactly, whatever the database's collation: list `Sales`, not `sales`, for a
schema created as `Sales`. `sys`, `INFORMATION_SCHEMA`, `guest` and the fixed-role schemas
(`db_owner`, …) are never read.

## Queries

A query runs as one request: the compiled `SELECT`, with every value a typed parameter. There is
nothing else in the request: no `SET`, no transaction.

**What keeps it read-only.** SQL Server has no read-only transaction. A query cannot write
because the statement zeteo sends is always a single `SELECT` built from the catalogue (no text
from the request reaches it, and identifiers are bracketed with `]` doubled), and because the
login is checked when the source is registered and refreshed (above): a login that can write is
refused. Keep the login read-only; it is the boundary.

**Session settings.** Results do not depend on the session's language, date format or first day
of the week: values are bound as ISO text cast to their type, buckets use `iso_week` (Monday), and
dates and times are read in binary. Every connection sets `ANSI_NULLS`, `ANSI_WARNINGS` and
`ARITHABORT` on when it opens, whatever the server's or login's defaults, so an overflow or a
division by zero fails the query instead of yielding `NULL`.

**Exact values.** The driver would read `decimal`, `numeric` and `money` as floating-point
numbers, so the select list returns them as text, as SQL Server prints them (a `decimal(12,2)` as
`"250.50"`). Sums run in `bigint` over smaller integers and in `decimal(38,0)` over `bigint`, so
they do not overflow where Postgres's would not; averages over exact columns divide the exact sum
once. Timestamps are read as UTC and cut at the millisecond; a `datetimeoffset` is converted to
UTC, a `datetime2`, `datetime` or `smalldatetime` taken as UTC.

**Stopping.** A query past the source's `timeout_ms`, or whose client goes away, is cancelled on
the server with an attention on its own connection (no second connection is needed, so a cancel
never waits for a busy pool); the driver's own request timeout, two seconds later, is the
backstop. Once the server acknowledges the cancel the connection goes back to the pool clean; if
it does not within two seconds, the connection is closed and the pool replaces it. Rows are read
as they arrive: at the row or size limit the request is cancelled and the rest of the result is
never read.

**Differences from Postgres.** Text comparison, sorting, `distinct` and grouping follow the
column's collation (case-insensitive by default; see [querying.md](querying.md)). A select item
whose type SQL Server cannot sort or group (`text`, `ntext`, `xml`) fails a query that sorts or
deduplicates by it, including by the default order, with `502 query_failed`; select it through a
view that converts it to `nvarchar(max)`.

## Exports and load

A source's queries run on the database it names. To keep exports and heavy reads off a primary,
point the source at a readable secondary or a copy that has its own hostname (a geo-replica, a
named replica in Hyperscale, or a database copy). Read scale-out replicas reached with
`ApplicationIntent=ReadOnly` are not supported: zeteo does not send that intent.
