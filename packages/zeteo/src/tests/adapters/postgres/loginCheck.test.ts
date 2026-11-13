// @module-tag int
// @module-tag platform
import type { PostgresConnection } from "../../../adapters/postgres/connect.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { Client } from "pg";
import {
  fixtureAdminSettings,
  fixtureSettings,
  fixtureTarget,
} from "../../support/fixtureDb.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 5000 };
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
const NOINHERIT = "zeteo_noinherit_login";
const HR_WRITER = "zeteo_hr_writer";
const REPLICATOR = "zeteo_replication_login";
const FILE_READER = "zeteo_file_reader";
const SIGNALLER = "zeteo_signaller";

beforeAll(async () => {
  await asAdmin(
    dropRole(MEMBER),
    dropRole(GROUP),
    dropRole(DEFAULTS),
    dropRole(NOINHERIT),
    dropRole(HR_WRITER),
    dropRole(REPLICATOR),
    dropRole(FILE_READER),
    dropRole(SIGNALLER),
    `CREATE ROLE ${GROUP}`,
    `GRANT USAGE ON SCHEMA sales TO ${GROUP}`,
    `GRANT UPDATE ON sales.blobs TO ${GROUP}`,
    `GRANT CREATE ON SCHEMA sales TO ${GROUP}`,
    `CREATE ROLE ${NOINHERIT} LOGIN NOINHERIT PASSWORD 'noinherit-pw' IN ROLE ${GROUP}`,
    `CREATE ROLE ${HR_WRITER} LOGIN PASSWORD 'hr-pw'`,
    `GRANT USAGE ON SCHEMA hr TO ${HR_WRITER}`,
    `GRANT SELECT, INSERT ON hr.salaries TO ${HR_WRITER}`,
    `CREATE ROLE ${REPLICATOR} LOGIN REPLICATION PASSWORD 'repl-pw'`,
    `CREATE ROLE ${FILE_READER} LOGIN PASSWORD 'file-pw' IN ROLE pg_read_server_files`,
    `CREATE ROLE ${SIGNALLER} LOGIN PASSWORD 'signal-pw' IN ROLE pg_signal_backend`,
    `CREATE ROLE ${MEMBER} LOGIN PASSWORD 'member-pw' IN ROLE ${GROUP}, pg_write_all_data`,
    `CREATE ROLE ${DEFAULTS} LOGIN PASSWORD 'defaults-pw'`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT INSERT ON TABLES TO ${DEFAULTS}`
  );
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asAdmin(
    dropRole(MEMBER),
    dropRole(GROUP),
    dropRole(DEFAULTS),
    dropRole(NOINHERIT),
    dropRole(HR_WRITER),
    dropRole(REPLICATOR),
    dropRole(FILE_READER),
    dropRole(SIGNALLER)
  );
});

describe("postgres checkLogin", () => {
  it("finds nothing wrong with a read-only login", async () => {
    const connection = await connectAs(fixtureSettings("ro"));
    expect(await connection.checkLogin()).toEqual([]);
  });

  it("finds the table a login can insert into", async () => {
    const connection = await connectAs(fixtureSettings("rw"));
    const findings = await connection.checkLogin();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("can_write_tables");
    expect(findings[0]!.detail).toContain("sales.orders");
  });

  it("finds a login that owns objects", async () => {
    const connection = await connectAs(fixtureSettings("owner"));
    const findings = await connection.checkLogin();
    expect(findings.map((f) => f.code)).toContain("owns_objects");
    expect(findings.find((f) => f.code === "owns_objects")!.detail).toContain(
      "sales.customers"
    );
  });

  it("finds a superuser and stops there, with one catalog query", async () => {
    const connection = (await connectAs(
      fixtureAdminSettings()
    )) as PostgresConnection;
    const query = vi.spyOn(connection.pool, "query");
    const findings = await connection.checkLogin();
    expect(findings.map((f) => f.code)).toContain("superuser");
    // The superuser owns the fixture's tables; once found, nothing else is looked for.
    expect(findings.map((f) => f.code)).not.toContain("owns_objects");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("finds membership of a server role that signals other backends, naming the role", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: SIGNALLER, password: "signal-pw" })
    );
    const findings = await connection.checkLogin();
    expect(findings).toContainEqual({
      code: "write_role_member",
      detail: expect.stringContaining("pg_signal_backend"),
    });
  });

  it("finds writes inherited from a role the login belongs to, and write-role membership", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: MEMBER, password: "member-pw" })
    );
    const findings = await connection.checkLogin();
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
    const findings = await connection.checkLogin();
    expect(
      findings.some(
        (f) => f.code === "can_write_tables" && f.detail.includes("Default")
      )
    ).toBe(true);
  });

  it("finds writes and CREATE reachable only through SET ROLE", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: NOINHERIT, password: "noinherit-pw" })
    );
    const findings = await connection.checkLogin();
    expect(
      findings.some(
        (f) => f.code === "can_write_tables" && f.detail.includes("sales.blobs")
      )
    ).toBe(true);
    expect(
      findings.some(
        (f) => f.code === "can_create_in_schema" && f.detail.includes("sales")
      )
    ).toBe(true);
  });

  it("finds a login that can write only in a schema no source lists", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: HR_WRITER, password: "hr-pw" })
    );
    const findings = await connection.checkLogin();
    expect(
      findings.some(
        (f) => f.code === "can_write_tables" && f.detail.includes("hr.salaries")
      )
    ).toBe(true);
  });

  it("finds a login that owns the database even after revoking its own CREATE", async () => {
    const connection = await connectAs(fixtureSettings("dbOwner"));
    const findings = await connection.checkLogin();
    expect(
      findings.some(
        (f) =>
          f.code === "owns_objects" && f.detail.includes("zeteo_fixture_owned")
      )
    ).toBe(true);
    // Its own CREATE on the database is gone: only ownership flags the database.
    expect(
      findings.some((f) => f.detail.includes("create schemas in database"))
    ).toBe(false);
  });

  it("finds a role with the replication attribute", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: REPLICATOR, password: "repl-pw" })
    );
    expect((await connection.checkLogin()).map((f) => f.code)).toContain(
      "replication"
    );
  });

  it("finds membership of pg_read_server_files", async () => {
    const connection = await connectAs(
      fixtureSettings("ro", { user: FILE_READER, password: "file-pw" })
    );
    expect((await connection.checkLogin()).map((f) => f.code)).toContain(
      "reads_server_files"
    );
  });
});
