// @module-tag int
// @module-tag platform
// @module-tag slow
import { closeAllSourcePools } from "../../../../sources/pools.js";
import { describeEachEngine } from "../../../support/engines.js";
import { bufferedBytes } from "../../../../export/httpSink.js";
import { removeSources } from "../../../support/sources.js";
import { startV1Routes } from "../../../support/v1App.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  eventually,
  ndjsonLines,
  newExportUser,
  openExport,
  readExport,
} from "../../../support/exports.js";
import {
  grantTo,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

const MB = 1024 * 1024;

describeEachEngine("POST /v1/export", (engine) => {
  let source: SeededSource;
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const user = newExportUser();

  beforeAll(async () => {
    source = await seedQuerySource(
      engine,
      {
        export_enabled: true,
        export_row_cap: 1_000_000,
        schemas: ["sales", "probe"],
      },
      "export"
    );
    await grantTo(user.principal, source.tables.wide_rows!, "all");
    // Served from this process, so the sink's buffer count can be read here.
    app = await startV1Routes();
  });
  afterAll(async () => {
    await app.close();
    await closeAllSourcePools();
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
  });

  it("completes a 20,000-row export read with a 5 s pause, buffering no more than a batch at a time", async () => {
    bufferedBytes.reset();
    const res = await openExport({
      token: user.token,
      baseUrl: app.url,
      body: {
        source: source.slug,
        from: "wide_rows",
        select: ["id", "filler"],
        where: { id: { lte: 20_000 } },
        orderBy: [{ id: "asc" }],
      },
    });
    expect(res.statusCode).toBe(200);
    // The first chunk, then 5 s without reading: the client's socket and the
    // server's fill, and the export must wait for them.
    const first = await new Promise<Buffer>((resolve) =>
      res.once("data", (chunk: Buffer) => {
        res.pause();
        resolve(chunk);
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const pausedAt = bufferedBytes.highWater();
    res.unshift(first);
    res.resume();
    const body = await readExport(res);

    const lines = ndjsonLines(body.text);
    expect(lines).toHaveLength(20_002);
    expect(lines[1]).toEqual([1, "x".repeat(2048)]);
    expect(lines.at(-2)).toEqual([20_000, "x".repeat(2048)]);
    expect(lines.at(-1)).toEqual({ status: "complete", rows: 20_000 });
    // Over 40 MB went out; the server never held more than a few MB of it.
    expect(body.raw.length).toBeGreaterThan(40_000_000);
    expect(pausedAt).toBeGreaterThan(0);
    expect(bufferedBytes.highWater()).toBeLessThan(4 * MB);

    const run = await eventually(async () => {
      const [found] = await runsOf([user.id]);
      return found?.outcome === "running" ? undefined : found;
    });
    expect(run).toMatchObject({ outcome: "ok", rowCount: 20_000 });
  });
});
