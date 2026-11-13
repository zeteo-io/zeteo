// @module-tag int
// @module-tag platform
import type { AzureSqlConnection } from "../../../adapters/azure-sql/connect.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import {
  asMssqlAdmin,
  dropLoginSql,
  ensureLoginSql,
  mssqlAdminSettings,
  mssqlFixtureSettings,
  mssqlFixtureTarget,
} from "../../support/mssqlFixture.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 10_000 };
const open: SourceConnection[] = [];

const PASSWORD = "Check-login-pw-1";

/** Logins made for this file, each with a user in the fixture database. */
const LOGINS = {
  datawriter: "zeteo_datawriter",
  ddladmin: "zeteo_ddladmin",
  dbOwner: "zeteo_db_owner",
  schemaAlter: "zeteo_schema_alter",
  schemaControl: "zeteo_schema_control",
  executor: "zeteo_executor",
  schemaOwner: "zeteo_schema_owner",
  nested: "zeteo_nested",
  columnUpdate: "zeteo_column_update",
  hrWriter: "zeteo_hr_writer",
  userAdmin: "zeteo_user_admin",
  securityAdmin: "zeteo_securityadmin",
  dbCreator: "zeteo_dbcreator",
  bulkAdmin: "zeteo_bulkadmin",
  processAdmin: "zeteo_processadmin",
  impersonator: "zeteo_impersonator",
  roleAlterer: "zeteo_role_alterer",
  roleOwner: "zeteo_role_owner",
  appRoleAlterer: "zeteo_app_role_alterer",
  loginImpersonator: "zeteo_login_impersonator",
} as const;

const connectAs = async (settings: ReturnType<typeof mssqlFixtureSettings>) => {
  const connection = await azureSqlAdapter.connect(
    settings,
    await mssqlFixtureTarget(),
    options
  );
  open.push(connection);
  return connection;
};

const as = (login: keyof typeof LOGINS) =>
  connectAs(
    mssqlFixtureSettings("ro", { user: LOGINS[login], password: PASSWORD })
  );

// In dependency order: a user that owns a schema, or a role with members,
// cannot be dropped.
const cleanDatabase = [
  "DROP PROCEDURE IF EXISTS sales.touch_order",
  "DROP SCHEMA IF EXISTS scratch",
  "IF DATABASE_PRINCIPAL_ID('zeteo_owned_role') IS NOT NULL DROP ROLE zeteo_owned_role",
  ...Object.values(LOGINS).map((user) => `DROP USER IF EXISTS [${user}]`),
  // An application role is the grantor of rights on itself: dropped after
  // the user it granted to.
  "IF DATABASE_PRINCIPAL_ID('zeteo_app_role') IS NOT NULL DROP APPLICATION ROLE zeteo_app_role",
  "IF DATABASE_PRINCIPAL_ID('zeteo_outer_role') IS NOT NULL DROP ROLE zeteo_outer_role",
  "IF DATABASE_PRINCIPAL_ID('zeteo_inner_writer') IS NOT NULL DROP ROLE zeteo_inner_writer",
];

beforeAll(async () => {
  await asMssqlAdmin(cleanDatabase);
  await asMssqlAdmin(
    Object.values(LOGINS).map((user) => ensureLoginSql(user, PASSWORD)),
    "master"
  );
  await asMssqlAdmin(
    [
      `ALTER SERVER ROLE securityadmin ADD MEMBER ${LOGINS.securityAdmin}`,
      `ALTER SERVER ROLE dbcreator ADD MEMBER ${LOGINS.dbCreator}`,
      `ALTER SERVER ROLE bulkadmin ADD MEMBER ${LOGINS.bulkAdmin}`,
      `ALTER SERVER ROLE processadmin ADD MEMBER ${LOGINS.processAdmin}`,
      `GRANT IMPERSONATE ON LOGIN::${LOGINS.dbOwner} TO ${LOGINS.loginImpersonator}`,
    ],
    "master"
  );
  await asMssqlAdmin([
    ...Object.values(LOGINS).map(
      (user) => `CREATE USER [${user}] FOR LOGIN [${user}]`
    ),
    `CREATE PROCEDURE sales.touch_order @id int AS UPDATE sales.orders SET notes = notes WHERE id = @id`,
    `CREATE SCHEMA scratch AUTHORIZATION ${LOGINS.schemaOwner}`,
    `CREATE ROLE zeteo_inner_writer`,
    `GRANT UPDATE ON sales.accounts TO zeteo_inner_writer`,
    `CREATE ROLE zeteo_outer_role`,
    `ALTER ROLE zeteo_inner_writer ADD MEMBER zeteo_outer_role`,
    `ALTER ROLE zeteo_outer_role ADD MEMBER ${LOGINS.nested}`,
    `ALTER ROLE db_datawriter ADD MEMBER ${LOGINS.datawriter}`,
    `ALTER ROLE db_ddladmin ADD MEMBER ${LOGINS.ddladmin}`,
    `ALTER ROLE db_owner ADD MEMBER ${LOGINS.dbOwner}`,
    `GRANT ALTER ON SCHEMA::hr TO ${LOGINS.schemaAlter}`,
    `GRANT CONTROL ON SCHEMA::sales TO ${LOGINS.schemaControl}`,
    `GRANT EXECUTE ON sales.touch_order TO ${LOGINS.executor}`,
    `GRANT UPDATE (notes) ON sales.orders TO ${LOGINS.columnUpdate}`,
    `GRANT SELECT, INSERT ON hr.salaries TO ${LOGINS.hrWriter}`,
    `GRANT ALTER ANY USER TO ${LOGINS.userAdmin}`,
    `GRANT IMPERSONATE ON USER::dbo TO ${LOGINS.impersonator}`,
    `GRANT ALTER ON ROLE::zeteo_inner_writer TO ${LOGINS.roleAlterer}`,
    `CREATE ROLE zeteo_owned_role AUTHORIZATION ${LOGINS.roleOwner}`,
    `CREATE APPLICATION ROLE zeteo_app_role WITH PASSWORD = 'App-role-pw-1'`,
    `GRANT ALTER ON APPLICATION ROLE::zeteo_app_role TO ${LOGINS.appRoleAlterer}`,
    // Read-only otherwise, so only the principal right can be found.
    ...[
      LOGINS.impersonator,
      LOGINS.roleAlterer,
      LOGINS.roleOwner,
      LOGINS.appRoleAlterer,
      LOGINS.loginImpersonator,
    ].map((user) => `ALTER ROLE db_datareader ADD MEMBER ${user}`),
    ...[
      LOGINS.securityAdmin,
      LOGINS.dbCreator,
      LOGINS.bulkAdmin,
      LOGINS.processAdmin,
    ].map((user) => `ALTER ROLE db_datareader ADD MEMBER ${user}`),
  ]);
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asMssqlAdmin(cleanDatabase);
  // A login is the grantor of IMPERSONATE on itself: its grantee goes first.
  const logins = Object.values(LOGINS);
  await asMssqlAdmin(
    [
      LOGINS.loginImpersonator,
      ...logins.filter((l) => l !== LOGINS.loginImpersonator),
    ].map(dropLoginSql),
    "master"
  );
});

const findingsOf = async (connection: SourceConnection) =>
  connection.checkLogin();

const has = (
  findings: Awaited<ReturnType<typeof findingsOf>>,
  code: string,
  detail: string
) => findings.some((f) => f.code === code && f.detail.includes(detail));

describe("azure-sql checkLogin", () => {
  it("finds nothing wrong with a db_datareader login", async () => {
    expect(
      await findingsOf(await connectAs(mssqlFixtureSettings("ro")))
    ).toEqual([]);
  });

  it("finds the table a login can insert into, and nothing else", async () => {
    const findings = await findingsOf(
      await connectAs(mssqlFixtureSettings("rw"))
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("can_write_tables");
    expect(findings[0]!.detail).toContain("sales.orders");
    expect(findings[0]!.detail).toContain("INSERT");
  });

  it("finds a login that owns a table", async () => {
    const findings = await findingsOf(
      await connectAs(mssqlFixtureSettings("owner"))
    );
    expect(has(findings, "owns_objects", "sales.customers")).toBe(true);
  });

  it("finds the server administrator and stops there, with one catalog query", async () => {
    const connection = (await connectAs(
      mssqlAdminSettings()
    )) as AzureSqlConnection;
    const request = vi.spyOn(connection.pool, "request");
    const findings = await findingsOf(connection);
    expect(findings.map((f) => f.code)).toContain("superuser");
    expect(new Set(findings.map((f) => f.code))).toEqual(
      new Set(["superuser", "owns_objects"])
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("finds a db_owner member as a superuser of the database", async () => {
    const findings = await findingsOf(await as("dbOwner"));
    expect(has(findings, "superuser", "db_owner")).toBe(true);
  });

  it("finds db_datawriter: writes across the database and the role", async () => {
    const findings = await findingsOf(await as("datawriter"));
    expect(has(findings, "can_write_tables", "INSERT")).toBe(true);
    expect(has(findings, "write_role_member", "db_datawriter")).toBe(true);
  });

  it("finds db_ddladmin: creating objects and the role", async () => {
    const findings = await findingsOf(await as("ddladmin"));
    expect(has(findings, "can_create_in_schema", "CREATE TABLE")).toBe(true);
    expect(has(findings, "write_role_member", "db_ddladmin")).toBe(true);
  });

  it("finds ALTER on a schema no source lists", async () => {
    const findings = await findingsOf(await as("schemaAlter"));
    expect(has(findings, "can_write_tables", "schema hr")).toBe(true);
  });

  it("finds CONTROL on a schema", async () => {
    const findings = await findingsOf(await as("schemaControl"));
    expect(has(findings, "can_write_tables", "schema sales")).toBe(true);
    expect(
      findings.find((f) => f.detail.includes("schema sales"))!.detail
    ).toContain("CONTROL");
  });

  it("finds EXECUTE on a procedure", async () => {
    const findings = await findingsOf(await as("executor"));
    expect(has(findings, "can_write_tables", "sales.touch_order")).toBe(true);
  });

  it("finds a login that owns a schema", async () => {
    const findings = await findingsOf(await as("schemaOwner"));
    expect(has(findings, "owns_objects", "schema scratch")).toBe(true);
  });

  it("finds writes held through nested roles, naming the role that holds them", async () => {
    const findings = await findingsOf(await as("nested"));
    expect(has(findings, "can_write_tables", "sales.accounts")).toBe(true);
    expect(has(findings, "write_role_member", "zeteo_inner_writer")).toBe(true);
  });

  it("finds UPDATE granted on one column", async () => {
    const findings = await findingsOf(await as("columnUpdate"));
    expect(has(findings, "can_write_tables", "sales.orders")).toBe(true);
  });

  it("finds a login that can write only in a schema no source lists", async () => {
    const findings = await findingsOf(await as("hrWriter"));
    expect(has(findings, "can_write_tables", "hr.salaries")).toBe(true);
  });

  it("finds ALTER ANY USER as managing principals", async () => {
    const findings = await findingsOf(await as("userAdmin"));
    expect(has(findings, "can_create_roles", "ALTER ANY USER")).toBe(true);
  });

  it("finds IMPERSONATE on the dbo user", async () => {
    const findings = await findingsOf(await as("impersonator"));
    expect(findings).toEqual([
      {
        code: "write_role_member",
        detail: "The login can IMPERSONATE user dbo",
      },
    ]);
  });

  it("finds ALTER on a role that writes, so the login could join it", async () => {
    const findings = await findingsOf(await as("roleAlterer"));
    expect(findings).toEqual([
      {
        code: "can_create_roles",
        detail: "The login can ALTER role zeteo_inner_writer",
      },
    ]);
  });

  it("finds a login that owns a role", async () => {
    const findings = await findingsOf(await as("roleOwner"));
    expect(has(findings, "owns_objects", "role zeteo_owned_role")).toBe(true);
    expect(has(findings, "can_create_roles", "zeteo_owned_role")).toBe(true);
  });

  it("finds ALTER on an application role", async () => {
    const findings = await findingsOf(await as("appRoleAlterer"));
    expect(findings).toEqual([
      {
        code: "can_create_roles",
        detail: "The login can ALTER application role zeteo_app_role",
      },
    ]);
  });

  it("finds IMPERSONATE on another login", async () => {
    const findings = await findingsOf(await as("loginImpersonator"));
    expect(findings).toEqual([
      {
        code: "write_role_member",
        detail: `The login can IMPERSONATE login ${LOGINS.dbOwner}`,
      },
    ]);
  });

  it.each([
    ["securityAdmin", "can_create_roles", "securityadmin"],
    ["dbCreator", "can_create_databases", "dbcreator"],
    ["bulkAdmin", "reads_server_files", "bulkadmin"],
    ["processAdmin", "write_role_member", "processadmin"],
  ] as const)(
    "finds membership of a server role: %s",
    async (login, code, role) => {
      const findings = await findingsOf(await as(login));
      expect(has(findings, code, role)).toBe(true);
    }
  );
});
