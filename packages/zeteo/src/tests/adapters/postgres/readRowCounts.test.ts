// @module-tag int
// @module-tag platform
import { fixtureSettings, fixtureTarget } from "../../support/fixtureDb.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { logger } from "../../../utils/logger.js";
import {
  createThrowawayDb,
  type ThrowawayDb,
} from "../../support/throwawayDb.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 5000 };

let db: ThrowawayDb;
let connection: SourceConnection;

const countsOf = async (schemas: string[]) =>
  Object.fromEntries(
    (await connection.readRowCounts(schemas))!.map((c) => [
      `${c.schemaName}.${c.name}`,
      c.rows,
    ])
  );

beforeAll(async () => {
  db = await createThrowawayDb();
  await db.run(`
    CREATE SCHEMA counted;
    CREATE TABLE counted.plain (id int PRIMARY KEY, body text);
    INSERT INTO counted.plain SELECT g, 'x' FROM generate_series(1, 2000) g;
    CREATE TABLE counted.events (at date NOT NULL, note text) PARTITION BY RANGE (at);
    CREATE TABLE counted.events_2025 PARTITION OF counted.events
      FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
    CREATE TABLE counted.events_2026 PARTITION OF counted.events
      FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    INSERT INTO counted.events
      SELECT DATE '2025-06-01' + (g % 400), 'y' FROM generate_series(1, 1000) g;
    CREATE TABLE counted.empty_parent (at date NOT NULL) PARTITION BY RANGE (at);
    CREATE MATERIALIZED VIEW counted.plain_ids AS SELECT id FROM counted.plain;
    CREATE VIEW counted.plain_view AS SELECT id FROM counted.plain;
    GRANT USAGE ON SCHEMA counted TO zeteo_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA counted TO zeteo_ro;`);
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

describe("postgres readRowCounts", () => {
  it("falls back to the live-row count for a table never analyzed; an empty one and every view have none", async () => {
    // A small table loaded once: autovacuum never analyzes it.
    await db.run(`
      CREATE TABLE counted.fresh (n int);
      CREATE TABLE counted.fresh_empty (n int);
      INSERT INTO counted.fresh SELECT g FROM generate_series(1, 10) g;
      SELECT pg_stat_force_next_flush();`);
    await vi.waitFor(
      async () =>
        expect((await countsOf(["counted"]))["counted.fresh"]).toBe(10),
      { timeout: 5000, interval: 200 }
    );
    const counts = await countsOf(["counted"]);
    expect(counts).not.toHaveProperty("counted.fresh_empty");
    expect(counts).not.toHaveProperty("counted.plain_view");
    await db.run("DROP TABLE counted.fresh, counted.fresh_empty");
  });

  it("gives the estimates after ANALYZE: a partitioned table sums its partitions, which are not listed", async () => {
    await db.run("ANALYZE counted.plain, counted.events, counted.plain_ids");
    const counts = await countsOf(["counted"]);
    expect(counts).toEqual({
      "counted.plain": 2000,
      "counted.events": 1000,
      "counted.empty_parent": 0,
      "counted.plain_ids": 2000,
    });
  });

  it("follows the statistics, not the table, until the next ANALYZE", async () => {
    await db.run("ANALYZE counted.plain");
    await db.run(
      "INSERT INTO counted.plain SELECT g, 'x' FROM generate_series(2001, 2500) g"
    );
    // The insert alone leaves the statistics as they were.
    expect((await countsOf(["counted"]))["counted.plain"]).toBe(2000);
    await db.run("ANALYZE counted.plain");
    expect((await countsOf(["counted"]))["counted.plain"]).toBe(2500);
  });

  it("is empty for no schema, an unknown one, or only system schemas", async () => {
    expect(await connection.readRowCounts([])).toEqual([]);
    expect(await connection.readRowCounts(["no_such_schema"])).toEqual([]);
    expect(
      await connection.readRowCounts(["pg_catalog", "information_schema"])
    ).toEqual([]);
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
      expect(await conn.readRowCounts(["counted"])).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "reading the source's row counts failed"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
