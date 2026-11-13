import type { LoginFinding } from "../types.js";
import type { ConnectionPool } from "mssql";

/**
 * The schemas SQL Server ships: guest, INFORMATION_SCHEMA, sys and one per
 * fixed database role. Their ids are the same in every database.
 */
const USER_SCHEMA = (alias: string) => `
  ${alias}.schema_id NOT IN (2, 3, 4)
  AND ${alias}.schema_id NOT BETWEEN 16384 AND 16399`;

/**
 * Whether a principal is the login's own user or a role (or Windows or Entra
 * group) it belongs to, directly or not.
 */
const MINE = (principalId: string) => `
  (${principalId} = DATABASE_PRINCIPAL_ID()
   OR IS_MEMBER(USER_NAME(${principalId})) = 1)`;

// Constant SQL. Every check here asks the server for the login's effective
// rights (HAS_PERMS_BY_NAME, fn_my_permissions, IS_MEMBER), which follow role
// membership and DENY, rather than reading grants the login may not be
// allowed to see.

// Anything that hands over the whole server or the whole database. The
// database owner and sysadmin both run as `dbo`.
const SUPERUSER = `
  SELECT IS_SRVROLEMEMBER(N'sysadmin') AS sysadmin,
         HAS_PERMS_BY_NAME(NULL, NULL, N'CONTROL SERVER') AS control_server,
         HAS_PERMS_BY_NAME(NULL, NULL, N'IMPERSONATE ANY LOGIN') AS impersonate_any_login,
         IS_ROLEMEMBER(N'db_owner') AS db_owner,
         HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CONTROL') AS control_database,
         CAST(CASE WHEN USER_NAME() = N'dbo' THEN 1 ELSE 0 END AS int) AS is_dbo,
         DB_NAME() AS database_name`;

// Fixed server roles, probed by name: Azure SQL Database answers for its own
// (##MS_…##) roles, SQL Server for both kinds. Unknown names answer NULL.
const SERVER_ROLES = `
  SELECT r.name FROM (VALUES
    (N'securityadmin'), (N'serveradmin'), (N'setupadmin'), (N'processadmin'),
    (N'diskadmin'), (N'dbcreator'), (N'bulkadmin'),
    (N'##MS_LoginManager##'), (N'##MS_DatabaseManager##'),
    (N'##MS_ServerStateManager##')
  ) r(name)
  WHERE IS_SRVROLEMEMBER(r.name) = 1
  ORDER BY r.name`;

// Server permissions that change the server, its logins or its databases, or
// read its files: every server permission but connecting and viewing. A
// login in Azure SQL Database may not see server-level catalogs, so each is
// probed directly; one the platform does not have answers NULL.
const SERVER_PERMISSIONS = `
  SELECT p.name FROM (VALUES
    (N'ADMINISTER BULK OPERATIONS'), (N'ALTER ANY AVAILABILITY GROUP'),
    (N'ALTER ANY CONNECTION'), (N'ALTER ANY CREDENTIAL'),
    (N'ALTER ANY DATABASE'), (N'ALTER ANY ENDPOINT'),
    (N'ALTER ANY EVENT NOTIFICATION'), (N'ALTER ANY EVENT SESSION'),
    (N'ALTER ANY LINKED SERVER'), (N'ALTER ANY LOGIN'),
    (N'ALTER ANY SERVER AUDIT'), (N'ALTER ANY SERVER ROLE'),
    (N'ALTER RESOURCES'), (N'ALTER SERVER STATE'), (N'ALTER SETTINGS'),
    (N'ALTER TRACE'), (N'AUTHENTICATE SERVER'), (N'CREATE ANY DATABASE'),
    (N'CREATE ANY EVENT SESSION'), (N'CREATE AVAILABILITY GROUP'),
    (N'CREATE DDL EVENT NOTIFICATION'), (N'CREATE ENDPOINT'),
    (N'CREATE LOGIN'), (N'CREATE SERVER ROLE'),
    (N'CREATE TRACE EVENT NOTIFICATION'), (N'DROP ANY EVENT SESSION'),
    (N'EXTERNAL ACCESS ASSEMBLY'), (N'SHUTDOWN'), (N'UNSAFE ASSEMBLY')
  ) p(name)
  WHERE HAS_PERMS_BY_NAME(NULL, NULL, p.name) = 1
  ORDER BY p.name`;

// Effective database permissions, fixed database roles included.
const DATABASE_PERMISSIONS = `
  SELECT DISTINCT permission_name AS name
    FROM fn_my_permissions(NULL, N'DATABASE')
   ORDER BY permission_name`;

// Roles the login belongs to, directly or through other roles, with the
// rights they were granted that are not read-only. Fixed roles carry their
// rights implicitly and are judged by name.
const DATABASE_ROLES = `
  SELECT DISTINCT r.name, r.is_fixed_role, p.permission_name
    FROM sys.database_principals r
    LEFT JOIN sys.database_permissions p
      ON p.grantee_principal_id = r.principal_id AND p.state IN ('G', 'W')
   WHERE r.type = 'R' AND r.name <> N'public' AND IS_ROLEMEMBER(r.name) = 1
   ORDER BY r.name, p.permission_name`;

const SCHEMA_PRIVILEGES = `
  SELECT s.name, p.name AS privilege
    FROM sys.schemas s
   CROSS JOIN (VALUES (N'INSERT'), (N'UPDATE'), (N'DELETE'), (N'EXECUTE'),
                      (N'ALTER'), (N'CONTROL'), (N'TAKE OWNERSHIP')) p(name)
   WHERE ${USER_SCHEMA("s")}
     AND HAS_PERMS_BY_NAME(QUOTENAME(s.name), N'SCHEMA', p.name) = 1
   ORDER BY s.name`;

// Tables, views and procedures: writes on the first two, EXECUTE on the last
// (a procedure writes with its owner's rights), changing or taking any.
const OBJECT_PRIVILEGES = `
  SELECT s.name AS schema_name, o.name, p.name AS privilege
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
   CROSS JOIN (VALUES (N'INSERT'), (N'UPDATE'), (N'DELETE'), (N'EXECUTE'),
                      (N'ALTER'), (N'CONTROL'), (N'TAKE OWNERSHIP')) p(name)
   WHERE ${USER_SCHEMA("s")}
     AND o.is_ms_shipped = 0
     AND o.type IN ('U', 'V', 'P', 'PC')
     AND (p.name <> N'EXECUTE' OR o.type IN ('P', 'PC'))
     AND (p.name NOT IN (N'INSERT', N'UPDATE', N'DELETE') OR o.type IN ('U', 'V'))
     AND HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), N'OBJECT', p.name) = 1
   ORDER BY s.name, o.name`;

// UPDATE granted on single columns, which the object-level probe does not see.
const COLUMN_UPDATES = `
  SELECT DISTINCT s.name AS schema_name, o.name
    FROM sys.database_permissions dp
    JOIN sys.objects o ON o.object_id = dp.major_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
   WHERE dp.class = 1 AND dp.minor_id <> 0
     AND dp.permission_name = N'UPDATE' AND dp.state IN ('G', 'W')
     AND ${USER_SCHEMA("s")}
     AND ${MINE("dp.grantee_principal_id")}
   ORDER BY s.name, o.name`;

const OWNED_SCHEMAS = `
  SELECT s.name FROM sys.schemas s
   WHERE ${USER_SCHEMA("s")} AND ${MINE("s.principal_id")}
   ORDER BY s.name`;

// An object has its own owner only when one was set; otherwise its schema's.
const OWNED_OBJECTS = `
  SELECT s.name AS schema_name, o.name
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
   WHERE ${USER_SCHEMA("s")}
     AND o.is_ms_shipped = 0
     AND o.principal_id IS NOT NULL
     AND ${MINE("o.principal_id")}
   ORDER BY s.name, o.name`;

/** Database permissions that only connect or read. */
const READ_ONLY_DATABASE = new Set([
  "CONNECT",
  "SELECT",
  "REFERENCES",
  "SHOWPLAN",
  "UNMASK",
  "SUBSCRIBE QUERY NOTIFICATIONS",
  "VIEW DEFINITION",
  "VIEW SECURITY DEFINITION",
  "VIEW PERFORMANCE DEFINITION",
  "VIEW CRYPTOGRAPHICALLY SECURED DEFINITION",
  "VIEW DATABASE STATE",
  "VIEW DATABASE PERFORMANCE STATE",
  "VIEW DATABASE SECURITY STATE",
  "VIEW DATABASE SECURITY AUDIT",
  "VIEW ANY COLUMN ENCRYPTION KEY DEFINITION",
  "VIEW ANY COLUMN MASTER KEY DEFINITION",
  "VIEW ANY SENSITIVITY CLASSIFICATION",
  "VIEW LEDGER CONTENT",
]);

type Code = LoginFinding["code"];

const databasePermissionCode = (name: string): Code => {
  if (
    [
      "ALTER ANY USER",
      "CREATE USER",
      "ALTER ANY ROLE",
      "CREATE ROLE",
      "ALTER ANY APPLICATION ROLE",
    ].includes(name)
  ) {
    return "can_create_roles";
  }
  if (name === "CREATE DATABASE") return "can_create_databases";
  if (name === "ADMINISTER DATABASE BULK OPERATIONS") {
    return "reads_server_files";
  }
  if (name === "ALTER ANY SECURITY POLICY" || name === "ALTER ANY MASK") {
    return "bypasses_row_security";
  }
  if (name === "CONNECT REPLICATION") return "replication";
  if (name.startsWith("CREATE ") || name === "ALTER ANY SCHEMA") {
    return "can_create_in_schema";
  }
  return "can_write_tables";
};

const serverPermissionCode = (name: string): Code => {
  if (
    [
      "ALTER ANY LOGIN",
      "CREATE LOGIN",
      "ALTER ANY SERVER ROLE",
      "CREATE SERVER ROLE",
    ].includes(name)
  ) {
    return "can_create_roles";
  }
  if (name === "CREATE ANY DATABASE" || name === "ALTER ANY DATABASE") {
    return "can_create_databases";
  }
  if (name === "ADMINISTER BULK OPERATIONS") return "reads_server_files";
  return "write_role_member";
};

const SERVER_ROLE_CODES: Record<string, Code> = {
  securityadmin: "can_create_roles",
  "##MS_LoginManager##": "can_create_roles",
  dbcreator: "can_create_databases",
  "##MS_DatabaseManager##": "can_create_databases",
  bulkadmin: "reads_server_files",
};

/** Fixed database roles whose members can change data, objects or principals. */
const WRITING_FIXED_ROLES = new Set([
  "db_owner",
  "db_accessadmin",
  "db_securityadmin",
  "db_ddladmin",
  "db_backupoperator",
  "db_datawriter",
]);

const qualified = (schema: string, name: string) => `${schema}.${name}`;

/**
 * Looks for any way the login could change data, objects, principals or the
 * server, across every non-system schema of the connected database: a
 * source's schema list can change without the login being checked again.
 * Role membership counts, nested roles included.
 */
export const checkLogin = async (
  pool: ConnectionPool
): Promise<LoginFinding[]> => {
  const findings: LoginFinding[] = [];
  const add = (code: Code, detail: string) => findings.push({ code, detail });
  const rows = async <T>(sql: string): Promise<T[]> =>
    (await pool.request().query<T>(sql)).recordset;

  const [top] = await rows<{
    sysadmin: number | null;
    control_server: number | null;
    impersonate_any_login: number | null;
    db_owner: number | null;
    control_database: number | null;
    is_dbo: number;
    database_name: string;
  }>(SUPERUSER);
  if (top!.sysadmin === 1)
    add("superuser", "The login is a member of sysadmin");
  if (top!.control_server === 1) {
    add("superuser", "The login holds CONTROL SERVER");
  }
  if (top!.impersonate_any_login === 1) {
    add("superuser", "The login holds IMPERSONATE ANY LOGIN");
  }
  if (top!.db_owner === 1)
    add("superuser", "The login is a member of db_owner");
  if (top!.control_database === 1) {
    add(
      "superuser",
      `The login holds CONTROL on database ${top!.database_name}`
    );
  }
  if (top!.is_dbo === 1) {
    add("owns_objects", `The login owns database ${top!.database_name}`);
  }
  // A superuser can do anything: the rest would only list everything it can
  // reach, which on a large database takes long enough to time the check out.
  if (findings.some((f) => f.code === "superuser")) return findings;

  for (const { name } of await rows<{ name: string }>(SERVER_ROLES)) {
    add(
      SERVER_ROLE_CODES[name] ?? "write_role_member",
      `The login is a member of server role ${name}`
    );
  }
  for (const { name } of await rows<{ name: string }>(SERVER_PERMISSIONS)) {
    add(
      serverPermissionCode(name),
      `The login holds server permission ${name}`
    );
  }

  // One finding per kind of database-wide right, naming the permissions.
  const databaseWide = new Set<string>();
  const byCode = new Map<Code, string[]>();
  for (const { name } of await rows<{ name: string }>(DATABASE_PERMISSIONS)) {
    if (READ_ONLY_DATABASE.has(name)) continue;
    databaseWide.add(name);
    const code = databasePermissionCode(name);
    byCode.set(code, [...(byCode.get(code) ?? []), name]);
  }
  for (const [code, names] of byCode) {
    add(
      code,
      `The login holds ${names.join(", ")} on database ${top!.database_name}`
    );
  }

  const roles = new Map<string, { fixed: boolean; privileges: string[] }>();
  for (const row of await rows<{
    name: string;
    is_fixed_role: boolean;
    permission_name: string | null;
  }>(DATABASE_ROLES)) {
    const role = roles.get(row.name) ?? {
      fixed: row.is_fixed_role,
      privileges: [],
    };
    if (row.permission_name && !READ_ONLY_DATABASE.has(row.permission_name)) {
      role.privileges.push(row.permission_name);
    }
    roles.set(row.name, role);
  }
  for (const [name, role] of roles) {
    if (role.fixed) {
      if (WRITING_FIXED_ROLES.has(name)) {
        add("write_role_member", `The login is a member of ${name}`);
      }
    } else if (role.privileges.length > 0) {
      add(
        "write_role_member",
        `The login is a member of role ${name}, which holds ${role.privileges.join(", ")}`
      );
    }
  }

  // A right held on the whole database holds on every schema and object in
  // it, and is already reported.
  const grouped = (
    list: { key: string; privilege: string }[]
  ): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const { key, privilege } of list) {
      if (databaseWide.has(privilege)) continue;
      map.set(key, [...(map.get(key) ?? []), privilege]);
    }
    return map;
  };

  const schemas = grouped(
    (await rows<{ name: string; privilege: string }>(SCHEMA_PRIVILEGES)).map(
      (r) => ({ key: r.name, privilege: r.privilege })
    )
  );
  for (const [schema, privileges] of schemas) {
    add(
      "can_write_tables",
      `The login can ${privileges.join(", ")} on schema ${schema}`
    );
  }

  const objects = grouped(
    (
      await rows<{ schema_name: string; name: string; privilege: string }>(
        OBJECT_PRIVILEGES
      )
    )
      .filter((r) => !schemas.get(r.schema_name)?.includes(r.privilege))
      .map((r) => ({
        key: qualified(r.schema_name, r.name),
        privilege: r.privilege,
      }))
  );
  for (const { schema_name, name } of await rows<{
    schema_name: string;
    name: string;
  }>(COLUMN_UPDATES)) {
    const key = qualified(schema_name, name);
    if (
      databaseWide.has("UPDATE") ||
      schemas.get(schema_name)?.includes("UPDATE")
    )
      continue;
    const held = objects.get(key) ?? [];
    if (!held.includes("UPDATE")) {
      objects.set(key, [...held, "UPDATE (some columns)"]);
    }
  }
  for (const [object, privileges] of objects) {
    add(
      "can_write_tables",
      `The login can ${privileges.join(", ")} on ${object}`
    );
  }

  for (const { name } of await rows<{ name: string }>(OWNED_SCHEMAS)) {
    add("owns_objects", `The login owns schema ${name}`);
  }
  for (const { schema_name, name } of await rows<{
    schema_name: string;
    name: string;
  }>(OWNED_OBJECTS)) {
    add("owns_objects", `The login owns ${qualified(schema_name, name)}`);
  }

  return findings;
};
