// @module-tag int
// @module-tag platform
// @module-tag slow
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { drainRequests, type ShutdownStep } from "../index.js";
import { resetExportShutdown } from "../engine/export.js";
import { closeAllSourcePools } from "../sources/pools.js";
import { describeEachEngine } from "./support/engines.js";
import { removeSources } from "./support/sources.js";
import { startV1Routes } from "./support/v1App.js";
import { stopTereo } from "../utils/tereo.js";
import {
  eventually,
  newExportUser,
  openExport,
  readExport,
} from "./support/exports.js";
import {
  grantTo,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "./support/queries.js";

/** Far longer than the drain may take once exports are stopped. */
const DRAIN_MS = 20_000;

describeEachEngine("drainRequests", (engine) => {
  let source: SeededSource;
  const users: string[] = [];

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
  });
  // abortExports refuses every later export in the process.
  afterEach(() => resetExportShutdown());
  afterAll(async () => {
    await closeAllSourcePools();
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("stops running exports before HTTP drains, so a streaming export does not hold the drain", async () => {
    const app = await startV1Routes();
    try {
      const user = newExportUser();
      users.push(user.id);
      await grantTo(user.principal, source.tables.trickle!, "all");
      // 100 rows 200 ms apart: twenty seconds of stream.
      const res = await openExport({
        token: user.token,
        baseUrl: app.url,
        body: {
          source: source.slug,
          from: "trickle",
          select: ["id", "filler"],
          orderBy: [{ id: "asc" }],
        },
      });
      expect(res.statusCode).toBe(200);
      const read = readExport(res).then(
        () => undefined,
        (err: unknown) => err
      );
      await eventually(async () =>
        (await engine.runningOn("trickle")) > 0 ? true : undefined
      );

      const steps: string[] = [];
      const step: ShutdownStep = async (name, run) => {
        steps.push(name);
        await run();
      };
      const began = Date.now();
      await drainRequests(step, app.server, DRAIN_MS);
      expect(Date.now() - began).toBeLessThan(5000);
      expect(steps).toEqual(["exports", "http"]);
      expect(app.server.listening).toBe(false);
      // Cut without its final chunk.
      expect(await read).toBeInstanceOf(Error);
      const run = await eventually(async () => {
        const [found] = await runsOf([user.id]);
        return found?.outcome === "running" ? undefined : found;
      });
      expect(run).toMatchObject({
        outcome: "failed",
        errorCode: "shutting_down",
      });
    } finally {
      if (app.server.listening) await app.close();
      else await stopTereo();
    }
  });
});
