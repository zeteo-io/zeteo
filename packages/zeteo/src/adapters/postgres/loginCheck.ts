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

// Every role the login is a member of, directly or not, itself included.
// MEMBER (not USAGE) because a member can SET ROLE to a role whose rights it
// does not inherit.
const ATTRIBUTES = `
  SELECT r.rolname, r.rolname = current_user AS is_self, r.rolsuper,
         r.rolcreaterole, r.rolcreatedb, r.rolbypassrls
    FROM pg_catalog.pg_roles r
   WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
   ORDER BY r.rolname`;

const OWNED_RELATIONS = `
  SELECT n.nspname, c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
   ORDER BY n.nspname, c.relname`;

const OWNED_SCHEMAS = `
  SELECT n.nspname
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname = ANY($1::text[])
     AND pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER')
   ORDER BY n.nspname`;

// Table-level or column-level INSERT/UPDATE, or table-level DELETE/TRUNCATE,
// held directly, through PUBLIC or through any inherited role.
const WRITABLE_RELATIONS = `
  SELECT n.nspname, c.relname,
         concat_ws(', ',
           CASE WHEN pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT') THEN 'INSERT' END,
           CASE WHEN pg_catalog.has_any_column_privilege(current_user, c.oid, 'UPDATE') THEN 'UPDATE' END,
           CASE WHEN pg_catalog.has_table_privilege(current_user, c.oid, 'DELETE') THEN 'DELETE' END,
           CASE WHEN pg_catalog.has_table_privilege(current_user, c.oid, 'TRUNCATE') THEN 'TRUNCATE' END
         ) AS privileges
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT')
       OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'UPDATE')
       OR pg_catalog.has_table_privilege(current_user, c.oid, 'DELETE')
       OR pg_catalog.has_table_privilege(current_user, c.oid, 'TRUNCATE'))
   ORDER BY n.nspname, c.relname`;

const CREATABLE_SCHEMAS = `
  SELECT n.nspname
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname = ANY($1::text[])
     AND pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE')
   ORDER BY n.nspname`;

const CAN_CREATE_IN_DATABASE = `
  SELECT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS allowed,
         current_database() AS name`;

// Server-level roles whose membership grants writes or code execution on the
// server's side, beyond any table's own grants.
const WRITE_ROLES = `
  SELECT r.rolname
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('pg_write_all_data', 'pg_write_server_files',
                       'pg_execute_server_program')
     AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
   ORDER BY r.rolname`;

// Default privileges that would give the login (or PUBLIC, or a role it
// inherits from) write rights on tables created later.
const DEFAULT_WRITE_GRANTS = `
  SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS creator,
         n.nspname,
         string_agg(DISTINCT a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
    FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
   WHERE d.defaclobjtype = 'r'
     AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     AND (a.grantee = 0 OR pg_catalog.pg_has_role(current_user, a.grantee, 'USAGE'))
     AND (d.defaclnamespace = 0 OR n.nspname = ANY($1::text[]))
   GROUP BY d.defaclrole, n.nspname
   ORDER BY creator, n.nspname`;

/**
 * Looks for any way the login could change data or the server, from catalog
 * queries only. Role membership counts: a login inherits, or can switch to,
 * the rights of every role it belongs to.
 */
export const checkLogin = async (
  pool: Pool,
  schemas: string[]
): Promise<LoginFinding[]> => {
  const listed = userSchemas(schemas);
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
  }

  const writeRoles = await pool.query<{ rolname: string }>(WRITE_ROLES);
  for (const { rolname } of writeRoles.rows) {
    add("write_role_member", `The login is a member of ${rolname}`);
  }

  const owned = await pool.query<{ nspname: string; relname: string }>(
    OWNED_RELATIONS,
    [listed]
  );
  for (const row of owned.rows) {
    add("owns_objects", `The login owns ${row.nspname}.${row.relname}`);
  }
  const ownedSchemas = await pool.query<{ nspname: string }>(OWNED_SCHEMAS, [
    listed,
  ]);
  for (const row of ownedSchemas.rows) {
    add("owns_objects", `The login owns schema ${row.nspname}`);
  }

  const writable = await pool.query<{
    nspname: string;
    relname: string;
    privileges: string;
  }>(WRITABLE_RELATIONS, [listed]);
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
  }>(DEFAULT_WRITE_GRANTS, [listed]);
  for (const row of defaults.rows) {
    const scope = row.nspname ? ` in schema ${row.nspname}` : "";
    add(
      "can_write_tables",
      `Default privileges grant ${row.privileges} on tables ${row.creator} creates later${scope}`
    );
  }

  const creatable = await pool.query<{ nspname: string }>(CREATABLE_SCHEMAS, [
    listed,
  ]);
  for (const row of creatable.rows) {
    add(
      "can_create_in_schema",
      `The login can create objects in ${row.nspname}`
    );
  }
  const database = await pool.query<{ allowed: boolean; name: string }>(
    CAN_CREATE_IN_DATABASE
  );
  if (database.rows[0]?.allowed) {
    add(
      "can_create_in_schema",
      `The login can create schemas in database ${database.rows[0].name}`
    );
  }

  return findings;
};
