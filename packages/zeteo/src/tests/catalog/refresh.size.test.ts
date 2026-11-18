// @module-tag int
// @module-tag platform
import { refreshDatabaseSource as refreshSource } from "../../catalog/refresh.js";
import { createThrowawayDb, type ThrowawayDb } from "../support/throwawayDb.js";
import { PostgresConnection } from "../../adapters/postgres/connect.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
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

describe("refreshSource: the source's size", () => {
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
        slug: uniqueSlug("refresh-size"),
        name: "Refresh size test",
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

  const sourceRow = () =>
    prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

  it("stores the size of the source's tables, measured during the read", async () => {
    const before = new Date();
    await refreshSource(sourceId, ACTOR);
    const row = await sourceRow();
    expect(row.sizeBytes).not.toBeNull();
    expect(Number(row.sizeBytes)).toBeGreaterThan(0);
    expect(row.sizeMeasuredAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime()
    );
    expect(row.sizeMeasuredAt!.getTime()).toBeLessThanOrEqual(
      row.lastRefreshedAt!.getTime()
    );
  });

  it("follows the source: a bigger table gives a bigger size", async () => {
    await refreshSource(sourceId, ACTOR);
    const first = Number((await sourceRow()).sizeBytes);
    await fixture.run(
      "INSERT INTO sales.order_lines SELECT 1, g, 'sku-' || g, 1, 1 FROM generate_series(1, 5000) g"
    );
    await refreshSource(sourceId, ACTOR);
    expect(Number((await sourceRow()).sizeBytes)).toBeGreaterThan(first);
  });

  it.each([
    ["returns null", () => Promise.resolve(null)],
    ["throws", () => Promise.reject(new Error("boom"))],
  ])(
    "still refreshes, and keeps the last size and when it was measured, when the size read %s",
    async (_, readSize) => {
      await refreshSource(sourceId, ACTOR);
      const before = await sourceRow();
      expect(before.sizeBytes).not.toBeNull();
      vi.spyOn(PostgresConnection.prototype, "readSize").mockImplementation(
        readSize
      );
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      const summary = await refreshSource(sourceId, ACTOR);
      expect(summary.tables.added).toBe(0);
      const row = await sourceRow();
      expect(row.status).toBe("active");
      expect(row.sizeBytes).toBe(before.sizeBytes);
      expect(row.sizeMeasuredAt).toEqual(before.sizeMeasuredAt);
      expect(row.lastRefreshedAt!.getTime()).toBeGreaterThan(
        before.lastRefreshedAt!.getTime()
      );
    }
  );
});
