// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { logger } from "../../../utils/logger.js";
import { Client } from "pg";
import {
  createThrowawayDb,
  type ThrowawayDb,
} from "../../support/throwawayDb.js";
import {
  fixtureAdminSettings,
  fixtureSettings,
  fixtureTarget,
} from "../../support/fixtureDb.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 5000 };

let db: ThrowawayDb;
let connection: SourceConnection;

/** The sizes Postgres gives the named relations, read as the server's superuser. */
const sizeOf = async (relations: string[]): Promise<number> => {
  const { host, port, user, password } = fixtureAdminSettings();
  const client = new Client({ host, port, user, password, database: db.name });
  await client.connect();
  try {
    const result = await client.query<{ bytes: string }>(
      `SELECT SUM(pg_total_relation_size(r::regclass))::int8 AS bytes
         FROM unnest($1::text[]) AS r`,
      [relations]
    );
    return Number(result.rows[0]!.bytes);
  } finally {
    await client.end();
  }
};

beforeAll(async () => {
  db = await createThrowawayDb();
  await db.run(`
    CREATE SCHEMA sized;
    CREATE TABLE sized.plain (id int PRIMARY KEY, body text);
    INSERT INTO sized.plain SELECT g, repeat('x', 200) FROM generate_series(1, 2000) g;
    CREATE TABLE sized.events (at date NOT NULL, note text) PARTITION BY RANGE (at);
    CREATE TABLE sized.events_2025 PARTITION OF sized.events
      FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
    CREATE TABLE sized.events_2026 PARTITION OF sized.events
      FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    INSERT INTO sized.events
      SELECT DATE '2025-06-01' + (g % 400), repeat('y', 100) FROM generate_series(1, 1000) g;
    CREATE MATERIALIZED VIEW sized.plain_ids AS SELECT id FROM sized.plain;
    CREATE VIEW sized.plain_view AS SELECT id FROM sized.plain;`);
  connection = await postgresAdapter.connect(
    fixtureSettings("ro", { database: db.name }),
    await fixtureTarget(),
    options
  );
});

afterAll(async () => {
  await connection?.close();
  await db?.drop();
});

describe("postgres readSize", () => {
  it("sums the tables, partitions and materialized views of the listed schemas, indexes included", async () => {
    const expected = await sizeOf([
      "sized.plain",
      "sized.events_2025",
      "sized.events_2026",
      "sized.plain_ids",
    ]);
    expect(expected).toBeGreaterThan(400_000);
    expect(await connection.readSize(["sized"])).toBe(expected);
  });

  it("adds every listed schema, even one the login cannot read", async () => {
    const sized = await connection.readSize(["sized"]);
    const both = await connection.readSize(["sized", "sales"]);
    expect(both).toBeGreaterThan(sized!);
    // The login has no right on hr, yet its tables count: size needs none.
    expect(await connection.readSize(["hr"])).toBe(
      await sizeOf(["hr.salaries"])
    );
  });

  it("is 0 for no schema, an unknown one, or only system schemas", async () => {
    expect(await connection.readSize([])).toBe(0);
    expect(await connection.readSize(["no_such_schema"])).toBe(0);
    expect(
      await connection.readSize(["pg_catalog", "information_schema"])
    ).toBe(0);
  });

  it("is null, never a throw, when the source cannot answer; the cause is logged", async () => {
    const conn = await postgresAdapter.connect(
      fixtureSettings("ro", { database: db.name }),
      await fixtureTarget(),
      options
    );
    await conn.close();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await conn.readSize(["sized"])).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "reading the source's size failed"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
