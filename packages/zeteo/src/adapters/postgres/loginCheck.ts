import type { LoginFinding } from "../types.js";
import type { Pool } from "pg";

export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

/** Listed schemas without the system ones, which are never inspected. */
export const userSchemas = (schemas: string[]): string[] =>
  schemas.filter(
    (name) =>
      !SYSTEM_SCHEMAS.includes(name) &&
      !name.startsWith("pg_temp_") &&
      !name.startsWith("pg_toast_temp_")
  );

// Constant SQL, no input: every schema a source could ever list.
const USER_SCHEMA = (alias: string) => `
  ${alias}.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND ${alias}.nspname NOT LIKE 'pg\\_temp\\_%'
  AND ${alias}.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

// Every role the login is a member of, directly or not, itself included.
// MEMBER, not USAGE: a member can SET ROLE to a role whose rights it does not
// inherit, so each privilege is tried against each of these roles.
const ME = `
  me AS (
    SELECT r.oid, r.rolname, r.rolname = current_user AS is_self, r.rolsuper,
           r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication
      FROM pg_catalog.pg_roles r
     WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
  )`;

const held = (call: string) => `EXISTS (SELECT 1 FROM me WHERE ${call})`;

const ATTRIBUTES = `WITH ${ME}
  SELECT rolname, is_self, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
         rolreplication
    FROM me ORDER BY rolname`;

// Server-level roles that write, or read files, on the server's side.
const SERVER_ROLES = `WITH ${ME}
  SELECT rolname FROM me
   WHERE rolname IN ('pg_write_all_data', 'pg_write_server_files',
                     'pg_execute_server_program', 'pg_read_server_files')
   ORDER BY rolname`;

const OWNED_RELATIONS = `WITH ${ME}
  SELECT n.nspname, c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMA("n")}
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND ${held("me.oid = c.relowner")}
   ORDER BY n.nspname, c.relname`;

const OWNED_SCHEMAS = `WITH ${ME}
  SELECT n.nspname
    FROM pg_catalog.pg_namespace n
   WHERE ${USER_SCHEMA("n")}
     AND ${held("me.oid = n.nspowner")}
   ORDER BY n.nspname`;

const OWNED_DATABASE = `WITH ${ME}
  SELECT d.datname
    FROM pg_catalog.pg_database d
   WHERE d.datname = current_database()
     AND ${held("me.oid = d.datdba")}`;

// Table-level or column-level INSERT/UPDATE, or table-level DELETE/TRUNCATE,
// held by any role the login belongs to, directly or through PUBLIC.
const WRITABLE_RELATIONS = `WITH ${ME}
  SELECT * FROM (
  SELECT n.nspname, c.relname,
         concat_ws(', ',
           CASE WHEN ${held("pg_catalog.has_any_column_privilege(me.oid, c.oid, 'INSERT')")} THEN 'INSERT' END,
           CASE WHEN ${held("pg_catalog.has_any_column_privilege(me.oid, c.oid, 'UPDATE')")} THEN 'UPDATE' END,
           CASE WHEN ${held("pg_catalog.has_table_privilege(me.oid, c.oid, 'DELETE')")} THEN 'DELETE' END,
           CASE WHEN ${held("pg_catalog.has_table_privilege(me.oid, c.oid, 'TRUNCATE')")} THEN 'TRUNCATE' END
         ) AS privileges
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMA("n")}
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ) w
   WHERE privileges <> ''
   ORDER BY nspname, relname`;

const CREATABLE_SCHEMAS = `WITH ${ME}
  SELECT n.nspname
    FROM pg_catalog.pg_namespace n
   WHERE ${USER_SCHEMA("n")}
     AND ${held("pg_catalog.has_schema_privilege(me.oid, n.oid, 'CREATE')")}
   ORDER BY n.nspname`;

const CREATABLE_DATABASE = `WITH ${ME}
  SELECT current_database() AS name
   WHERE ${held("pg_catalog.has_database_privilege(me.oid, current_database(), 'CREATE')")}`;

// Default privileges that would give a role the login belongs to (or PUBLIC)
// write rights on tables created later.
const DEFAULT_WRITE_GRANTS = `WITH ${ME}
  SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS creator,
         n.nspname,
         string_agg(DISTINCT a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
    FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
   WHERE d.defaclobjtype = 'r'
     AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     AND (a.grantee = 0 OR ${held("me.oid = a.grantee")})
     AND (d.defaclnamespace = 0 OR ${USER_SCHEMA("n")})
   GROUP BY d.defaclrole, n.nspname
   ORDER BY creator, n.nspname`;

/**
 * Looks for any way the login could change data or the server, from catalog
 * queries only, across every non-system schema of the connected database: a
 * source's schema list can change without the login being checked again.
 * Role membership counts: the login has, or can switch to, the rights of
 * every role it belongs to.
 */
export const checkLogin = async (pool: Pool): Promise<LoginFinding[]> => {
  const findings: LoginFinding[] = [];
  const add = (code: LoginFinding["code"], detail: string) =>
    findings.push({ code, detail });

  const attributes = await pool.query<{
    rolname: string;
    is_self: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
  }>(ATTRIBUTES);
  for (const role of attributes.rows) {
    const where = role.is_self ? "" : ` (through role ${role.rolname})`;
    if (role.rolsuper) add("superuser", `The login is a superuser${where}`);
    if (role.rolcreaterole)
      add("can_create_roles", `The login can create roles${where}`);
    if (role.rolcreatedb)
      add("can_create_databases", `The login can create databases${where}`);
    if (role.rolbypassrls)
      add("bypasses_row_security", `The login bypasses row security${where}`);
    if (role.rolreplication)
      add("replication", `The login has the replication attribute${where}`);
  }

  const serverRoles = await pool.query<{ rolname: string }>(SERVER_ROLES);
  for (const { rolname } of serverRoles.rows) {
    if (rolname === "pg_read_server_files") {
      add("reads_server_files", `The login is a member of ${rolname}`);
    } else {
      add("write_role_member", `The login is a member of ${rolname}`);
    }
  }

  const owned = await pool.query<{ nspname: string; relname: string }>(
    OWNED_RELATIONS
  );
  for (const row of owned.rows) {
    add("owns_objects", `The login owns ${row.nspname}.${row.relname}`);
  }
  const ownedSchemas = await pool.query<{ nspname: string }>(OWNED_SCHEMAS);
  for (const row of ownedSchemas.rows) {
    add("owns_objects", `The login owns schema ${row.nspname}`);
  }
  const ownedDatabase = await pool.query<{ datname: string }>(OWNED_DATABASE);
  for (const row of ownedDatabase.rows) {
    add("owns_objects", `The login owns database ${row.datname}`);
  }

  const writable = await pool.query<{
    nspname: string;
    relname: string;
    privileges: string;
  }>(WRITABLE_RELATIONS);
  for (const row of writable.rows) {
    add(
      "can_write_tables",
      `The login can ${row.privileges} on ${row.nspname}.${row.relname}`
    );
  }
  const defaults = await pool.query<{
    creator: string;
    nspname: string | null;
    privileges: string;
  }>(DEFAULT_WRITE_GRANTS);
  for (const row of defaults.rows) {
    const scope = row.nspname ? ` in schema ${row.nspname}` : "";
    add(
      "can_write_tables",
      `Default privileges grant ${row.privileges} on tables ${row.creator} creates later${scope}`
    );
  }

  const creatable = await pool.query<{ nspname: string }>(CREATABLE_SCHEMAS);
  for (const row of creatable.rows) {
    add(
      "can_create_in_schema",
      `The login can create objects in ${row.nspname}`
    );
  }
  const database = await pool.query<{ name: string }>(CREATABLE_DATABASE);
  for (const row of database.rows) {
    add(
      "can_create_in_schema",
      `The login can create schemas in database ${row.name}`
    );
  }

  return findings;
};
