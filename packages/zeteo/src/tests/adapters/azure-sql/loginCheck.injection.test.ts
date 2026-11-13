// @module-tag int
// @module-tag platform
// @module-tag security
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../../../adapters/types.js";
import {
  asMssqlAdmin,
  dropLoginSql,
  ensureLoginSql,
  mssqlFixtureSettings,
  mssqlFixtureTarget,
  quoteMssqlIdent as q,
  quoteMssqlLiteral as lit,
} from "../../support/mssqlFixture.js";

const options = { connectTimeoutMs: 5000, poolSize: 1, queryTimeoutMs: 10_000 };
const open: SourceConnection[] = [];
const PASSWORD = "Inject-login-pw-1";

// Each holds a dot, a closing bracket, a quote and a space: a name the server
// would misread as several parts, or not at all, if it were not quoted.
const HOSTILE = ".h] 'x y";
const H = {
  role: `zeteo_role${HOSTILE}`,
  writerRole: `zeteo_writer${HOSTILE}`,
  user: `zeteo_user${HOSTILE}`,
  schema: `zeteo_schema${HOSTILE}`,
  ownedSchema: `zeteo_owned${HOSTILE}`,
  table: `zeteo_table${HOSTILE}`,
  login: `zeteo_login${HOSTILE}`,
  database: `zeteo_fixture${HOSTILE}`,
};

const LOGINS = {
  roleAlterer: "zeteo_inj_role_alterer",
  impersonator: "zeteo_inj_impersonator",
  schemaWriter: "zeteo_inj_schema_writer",
  objectWriter: "zeteo_inj_object_writer",
  member: "zeteo_inj_member",
  loginImpersonator: "zeteo_inj_login_impersonator",
  databaseController: "zeteo_inj_database_controller",
} as const;

const dropPrincipal = (name: string, kind: "ROLE" | "USER") =>
  `IF DATABASE_PRINCIPAL_ID(${lit(name)}) IS NOT NULL DROP ${kind} ${q(name)}`;

// In dependency order: objects before their schemas, a schema before the
// role that owns it, members before roles.
const cleanFixture = [
  `DROP TABLE IF EXISTS ${q(H.schema)}.${q(H.table)}`,
  `DROP SCHEMA IF EXISTS ${q(H.schema)}`,
  `DROP SCHEMA IF EXISTS ${q(H.ownedSchema)}`,
  ...Object.values(LOGINS).map((user) => `DROP USER IF EXISTS ${q(user)}`),
  dropPrincipal(H.user, "USER"),
  dropPrincipal(H.role, "ROLE"),
  dropPrincipal(H.writerRole, "ROLE"),
];

const dropDatabase = `
  IF DB_ID(${lit(H.database)}) IS NOT NULL
  BEGIN
    ALTER DATABASE ${q(H.database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE ${q(H.database)};
  END`;

// A login is the grantor of IMPERSONATE on itself: its grantee goes first.
const dropLogins = [
  dropLoginSql(LOGINS.loginImpersonator),
  ...Object.values(LOGINS)
    .filter((l) => l !== LOGINS.loginImpersonator)
    .map(dropLoginSql),
  dropLoginSql(H.login),
];

beforeAll(async () => {
  await asMssqlAdmin(cleanFixture);
  await asMssqlAdmin([dropDatabase, ...dropLogins], "master");
  await asMssqlAdmin(
    [
      ...Object.values(LOGINS).map((user) => ensureLoginSql(user, PASSWORD)),
      ensureLoginSql(H.login, PASSWORD),
      `GRANT IMPERSONATE ON LOGIN::${q(H.login)} TO ${q(LOGINS.loginImpersonator)}`,
      `CREATE DATABASE ${q(H.database)}`,
    ],
    "master"
  );
  await asMssqlAdmin([
    ...Object.values(LOGINS).map(
      (user) => `CREATE USER ${q(user)} FOR LOGIN ${q(user)}`
    ),
    `CREATE ROLE ${q(H.role)}`,
    `CREATE ROLE ${q(H.writerRole)}`,
    `CREATE USER ${q(H.user)} WITHOUT LOGIN`,
    `CREATE SCHEMA ${q(H.schema)}`,
    `CREATE SCHEMA ${q(H.ownedSchema)} AUTHORIZATION ${q(H.writerRole)}`,
    `CREATE TABLE ${q(H.schema)}.${q(H.table)} (id int)`,
    `GRANT ALTER ON ROLE::${q(H.role)} TO ${q(LOGINS.roleAlterer)}`,
    `GRANT IMPERSONATE ON USER::${q(H.user)} TO ${q(LOGINS.impersonator)}`,
    `GRANT INSERT ON SCHEMA::${q(H.schema)} TO ${q(LOGINS.schemaWriter)}`,
    `GRANT UPDATE ON ${q(H.schema)}.${q(H.table)} TO ${q(LOGINS.objectWriter)}`,
    `GRANT INSERT ON sales.orders TO ${q(H.writerRole)}`,
    `ALTER ROLE ${q(H.writerRole)} ADD MEMBER ${q(LOGINS.member)}`,
  ]);
  await asMssqlAdmin(
    [
      `CREATE USER ${q(LOGINS.databaseController)} FOR LOGIN ${q(LOGINS.databaseController)}`,
      `GRANT CONTROL ON DATABASE::${q(H.database)} TO ${q(LOGINS.databaseController)}`,
    ],
    H.database
  );
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asMssqlAdmin(cleanFixture);
  await asMssqlAdmin([dropDatabase, ...dropLogins], "master");
});

const checkAs = async (
  login: keyof typeof LOGINS,
  database?: string
): Promise<{ code: string; detail: string }[]> => {
  const connection = await azureSqlAdapter.connect(
    mssqlFixtureSettings("ro", {
      user: LOGINS[login],
      password: PASSWORD,
      ...(database === undefined ? {} : { database }),
    }),
    await mssqlFixtureTarget(),
    options
  );
  open.push(connection);
  return connection.checkLogin();
};

describe("azure-sql checkLogin with hostile names", () => {
  it("finds ALTER on a role whose name holds a dot, a bracket, a quote and a space", async () => {
    expect(await checkAs("roleAlterer")).toEqual([
      {
        code: "can_create_roles",
        detail: `The login can ALTER role ${H.role}`,
      },
    ]);
  });

  it("finds IMPERSONATE on such a user", async () => {
    expect(await checkAs("impersonator")).toEqual([
      {
        code: "write_role_member",
        detail: `The login can IMPERSONATE user ${H.user}`,
      },
    ]);
  });

  it("finds a write on such a schema", async () => {
    expect(await checkAs("schemaWriter")).toEqual([
      {
        code: "can_write_tables",
        detail: `The login can INSERT on schema ${H.schema}`,
      },
    ]);
  });

  it("finds a write on such a table in such a schema", async () => {
    expect(await checkAs("objectWriter")).toEqual([
      {
        code: "can_write_tables",
        detail: `The login can UPDATE on ${H.schema}.${H.table}`,
      },
    ]);
  });

  it("finds membership of such a role, and the schema it owns", async () => {
    const findings = await checkAs("member");
    expect(findings).toContainEqual({
      code: "write_role_member",
      detail: `The login is a member of role ${H.writerRole}, which holds INSERT`,
    });
    expect(findings).toContainEqual({
      code: "owns_objects",
      detail: `The login owns schema ${H.ownedSchema}`,
    });
    expect(findings).toContainEqual({
      code: "can_write_tables",
      detail: "The login can INSERT on sales.orders",
    });
  });

  it("finds IMPERSONATE on such a login", async () => {
    expect(await checkAs("loginImpersonator")).toEqual([
      {
        code: "write_role_member",
        detail: `The login can IMPERSONATE login ${H.login}`,
      },
    ]);
  });

  it("finds CONTROL on such a database", async () => {
    expect(await checkAs("databaseController", H.database)).toContainEqual({
      code: "superuser",
      detail: `The login holds CONTROL on database ${H.database}`,
    });
  });
});
