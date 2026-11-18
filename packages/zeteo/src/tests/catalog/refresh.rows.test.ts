// @module-tag int
// @module-tag platform
import { createThrowawayDb, type ThrowawayDb } from "../support/throwawayDb.js";
import { PostgresConnection } from "../../adapters/postgres/connect.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { refreshSource } from "../../catalog/refresh.js";
import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import { randomUUID } from "crypto";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../support/sources.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const ACTOR = randomUUID();

describe("refreshSource: the tables' estimated rows", () => {
  const sources: string[] = [];
  let fixture: ThrowawayDb;
  let sourceId: string;

  beforeAll(async () => {
    await initializeTereo();
  });
  afterAll(async () => {
    await removeSources(sources);
    await stopTereo();
  });
  beforeEach(async () => {
    fixture = await createThrowawayDb();
    sourceId = randomUUID();
    sources.push(sourceId);
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: uniqueSlug("refresh-rows"),
        name: "Refresh rows test",
        type: "postgres",
        sealedSettings: sealSettings(
          sourceSettings("ro", { database: fixture.name }),
          sourceId
        ) as object,
        schemas: ["sales"],
        createdBy: randomUUID(),
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAllSourcePools();
    await fixture.drop();
  });

  const counts = async () =>
    Object.fromEntries(
      (
        await prisma.sourceTable.findMany({
          where: { sourceId },
          select: { name: true, rowCount: true },
        })
      ).map((t) => [t.name, t.rowCount === null ? null : Number(t.rowCount)])
    );

  it("stores each table's estimate, a never-analyzed table's live-row count, and null for a view", async () => {
    await fixture.run("ANALYZE sales.orders, sales.customers");
    await refreshSource(sourceId, ACTOR);
    const rows = await counts();
    expect(rows.orders).toBe(12);
    expect(rows.customers).toBe(3);
    // Never analyzed: the statistics collector's live rows.
    expect(rows.accounts).toBe(2);
    expect(rows.paid_orders).toBeNull();
  });

  it("follows the statistics at each refresh", async () => {
    await fixture.run("ANALYZE sales.order_lines");
    await refreshSource(sourceId, ACTOR);
    expect((await counts()).order_lines).toBe(2);
    await fixture.run(
      "INSERT INTO sales.order_lines SELECT 1, g, 'sku-' || g, 1, 1 FROM generate_series(3, 5002) g; ANALYZE sales.order_lines"
    );
    await refreshSource(sourceId, ACTOR);
    expect((await counts()).order_lines).toBe(5002);
  });

  it("keeps a missing table's last estimate", async () => {
    await fixture.run("ANALYZE sales.ledger");
    await refreshSource(sourceId, ACTOR);
    await fixture.run("DROP TABLE sales.ledger");
    const summary = await refreshSource(sourceId, ACTOR);
    expect(summary.tables.missing).toBe(1);
    expect((await counts()).ledger).toBe(4);
  });

  it.each([
    ["returns null", () => Promise.resolve(null)],
    ["throws", () => Promise.reject(new Error("boom"))],
  ])(
    "still refreshes, and keeps the last estimates, when the row count read %s",
    async (_, readRowCounts) => {
      await fixture.run("ANALYZE sales.orders");
      await refreshSource(sourceId, ACTOR);
      expect((await counts()).orders).toBe(12);
      vi.spyOn(
        PostgresConnection.prototype,
        "readRowCounts"
      ).mockImplementation(readRowCounts);
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      const summary = await refreshSource(sourceId, ACTOR);
      expect(summary.tables.added).toBe(0);
      const source = await prisma.source.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(source.status).toBe("active");
      // A passing failure does not blank the counts.
      expect((await counts()).orders).toBe(12);
    }
  );

  it("stores an estimate past 32 bits", async () => {
    await refreshSource(sourceId, ACTOR);
    vi.spyOn(PostgresConnection.prototype, "readRowCounts").mockResolvedValue([
      { schemaName: "sales", name: "orders", rows: 5_000_000_000 },
    ]);
    await refreshSource(sourceId, ACTOR);
    const rows = await counts();
    expect(rows.orders).toBe(5_000_000_000);
    expect(rows.customers).toBeNull();
  });
});
