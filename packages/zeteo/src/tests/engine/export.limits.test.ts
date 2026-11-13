// @module-tag int
// @module-tag platform
// @module-tag slow
import { DATA_EXPORT, DATA_READ } from "../../definitions/tereoDeclaration.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import type { ExportSink } from "../../engine/export.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { BATCH_BYTES } from "../../engine/collect.js";
import { runExport } from "../../engine/export.js";
import {
  HIGH_WATER_BYTES,
  queuedBytes,
} from "../../adapters/azure-sql/runQuery.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

/** About the bytes of one row of `probe.huge_rows`: 300,000 characters and its id. */
const ROW = 300_020;

describeEachEngine("runExport", (engine) => {
  let source: SeededSource;
  const users: string[] = [];

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(
      engine,
      {
        export_enabled: true,
        export_row_cap: 1_000_000,
        schemas: ["sales", "probe"],
      },
      "export"
    );
  });
  afterAll(async () => {
    await closeAllSourcePools();
    await removeRunsOf(users);
    await removeSources([source.id]);
    await stopTereo();
  });

  it("sizes its batches by bytes: one row first, then about BATCH_BYTES of rows, and the source reads no further ahead", async () => {
    const user = newQueryUser();
    users.push(user.id);
    await grantTo(user.principal, source.tables.huge_rows!, "all");
    queuedBytes.reset();
    const sizes: number[] = [];
    let received = 0;
    let last: unknown;
    const sink: ExportSink = {
      start: async () => undefined,
      rows: async (batch) => {
        sizes.push(
          batch.reduce(
            (sum: number, row) => sum + Buffer.byteLength(JSON.stringify(row)),
            0
          )
        );
        received += batch.length;
        last = batch.at(-1);
        // A slow reader: a source that is not held back gets ahead of it.
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      end: async () => undefined,
    };
    await runExport(
      {
        caller: {
          userId: user.id,
          organizationId: null,
          permissions: [DATA_READ, DATA_EXPORT],
          isServiceAccount: false,
        },
        body: {
          source: source.slug,
          from: "huge_rows",
          select: ["id", "filler"],
          orderBy: [{ id: "asc" }],
        },
        signal: new AbortController().signal,
      },
      sink
    );
    // 100 rows of 300,000 characters: 30 MB in all.
    expect(received).toBe(100);
    expect(last).toEqual([100, "y".repeat(300_000)]);
    expect(sizes[0]).toBeLessThan(ROW);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(BATCH_BYTES + ROW);
    if (engine.type === "azure-sql") {
      expect(queuedBytes.highWater()).toBeGreaterThan(0);
      expect(queuedBytes.highWater()).toBeLessThanOrEqual(
        HIGH_WATER_BYTES + ROW
      );
    }
  });
});
