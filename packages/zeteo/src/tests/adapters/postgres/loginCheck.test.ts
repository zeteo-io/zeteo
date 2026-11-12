// @module-tag int
// @module-tag platform
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../../../adapters/types.js";
import { Client } from "pg";
import {
  fixtureAdminSettings,
  fixtureSettings,
  fixtureTarget,
} from "../../support/fixtureDb.js";

const options = { connectTimeoutMs: 5000, poolSize: 2 };
const open: SourceConnection[] = [];

const connectAs = async (settings: ReturnType<typeof fixtureSettings>) => {
  const connection = await postgresAdapter.connect(
    settings,
    await fixtureTarget(),
    options
  );
  open.push(connection);
  return connection;
};

const asAdmin = async (...statements: string[]) => {
  const client = new Client({ ...fixtureAdminSettings(), ssl: false });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
};

const dropRole = (role: string) =>
  `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN DROP OWNED BY ${role}; DROP ROLE ${role}; END IF; END $$`;

const MEMBER = "zeteo_member_login";
const GROUP = "zeteo_writers_group";
const DEFAULTS = "zeteo_defaults_login";

beforeAll(async () => {
  await asAdmin(
    dropRole(MEMBER),
    dropRole(GROUP),
    dropRole(DEFAULTS),
    `CREATE ROLE ${GROUP}`,
    `GRANT USAGE ON SCHEMA sales TO ${GROUP}`,
    `GRANT UPDATE ON sales.blobs TO ${GROUP}`,
    `CREATE ROLE ${MEMBER} LOGIN PASSWORD 'member-pw' IN ROLE ${GROUP}, pg_write_all_data`,
    `CREATE ROLE ${DEFAULTS} LOGIN PASSWORD 'defaults-pw'`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT INSERT ON TABLES TO ${DEFAULTS}`
  );
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asAdmin(dropRole(MEMBER), dropRole(GROUP), dropRole(DEFAULTS));
});

describe("postgres checkLogin", () => {
  it("finds nothing wrong with a read-only login", async () => {
    const connection = await connectAs(fixtureSettings("ro"));
    expect(await connection.checkLogin(["sales", "hr"])).toEqual([]);
  });

  it("finds the table a login can insert into", async () => {
    const connection = await connectAs(fixtureSettings("rw"));
    const findings = await connection.checkLogin(["sales"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("can_write_tables");
    expect(findings[0]!.detail).toContain("sales.orders");
  });

  it("finds a login that owns objects", async () => {
    const connection = await connectAs(fixtureSettings("owner"));
    const findings = await connection.checkLogin(["sales"]);
    expect(findings.map((f) => f.code)).toContain("owns_objects");
    expect(findings.find((f) => f.code === "owns_objects")!.detail).toContain(
      "sales.customers"
    );
  });

  it("finds a superuser", async () => {
    const connection = await connectAs(fixtureAdminSettings());
    const findings = await connection.checkLogin(["sales"]);
    expect(findings.map((f) => f.code)).toContain("superuser");
  });

  it("does not splice a schema name into SQL", async () => {
    const connection = await connectAs(fixtureSettings("ro"));
    const findings = await connection.checkLogin(["sales'; DROP TABLE x; --"]);
    expect(findings).toEqual([]);
  });

  it("finds writes inherited from a role the login belongs to, and write-role membership", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: MEMBER, password: "member-pw" })
    );
    const findings = await connection.checkLogin(["sales"]);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("write_role_member");
    expect(
      findings.some(
        (f) => f.code === "can_write_tables" && f.detail.includes("sales.blobs")
      )
    ).toBe(true);
  });

  it("finds default privileges that would grant writes on future tables", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: DEFAULTS, password: "defaults-pw" })
    );
    const findings = await connection.checkLogin(["sales"]);
    expect(
      findings.some(
        (f) => f.code === "can_write_tables" && f.detail.includes("Default")
      )
    ).toBe(true);
  });
});
