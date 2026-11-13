// @module-tag int
// @module-tag platform
// @module-tag slow
import { DATA_EXPORT, DATA_READ } from "../../definitions/tereoDeclaration.js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { recordExportEnd } from "../../engine/record.js";
import type { ExportSink } from "../../engine/export.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { eventually } from "../support/exports.js";
import { runExport } from "../../engine/export.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// The recorder as the engine sees it, made to fail when a test says so.
vi.mock(import("../../engine/record.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordExportEnd: vi.fn(actual.recordExportEnd) };
});

/** The engine's attempts at an end record: the first and three more. */
const ATTEMPTS = 4;
/** Longer than every wait between the attempts together. */
const RETRIES_MS = 8000;

describeEachEngine("runExport: recording the end", (engine) => {
  let source: SeededSource;
  const users: string[] = [];

  const grantedCaller = async (): Promise<Caller> => {
    const user = newQueryUser();
    users.push(user.id);
    await grantTo(user.principal, source.tables.customers!, "all");
    return {
      userId: user.id,
      organizationId: null,
      permissions: [DATA_READ, DATA_EXPORT],
      isServiceAccount: false,
    };
  };

  const sinkOf = (rows: ExportSink["rows"] = async () => undefined) => {
    const ends: unknown[] = [];
    const sink: ExportSink = {
      start: async () => undefined,
      rows,
      end: async (tail) => {
        ends.push(tail);
      },
    };
    return { sink, ends };
  };

  const exportCustomers = (caller: Caller, sink: ExportSink) =>
    runExport(
      {
        caller,
        body: { source: source.slug, from: "customers", select: ["id"] },
        signal: new AbortController().signal,
      },
      sink
    );

  const outage = () => Promise.reject(new Error("zeteo's database is away"));

  const closedRun = (caller: Caller) =>
    eventually(async () => {
      const [run] = await runsOf([caller.userId]);
      return run?.outcome === "running" ? undefined : run;
    }, RETRIES_MS);

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 1_000_000 },
      "export"
    );
  });
  afterEach(() => {
    vi.mocked(recordExportEnd).mockClear();
  });
  afterAll(async () => {
    await closeAllSourcePools();
    await removeRunsOf(users);
    await removeSources([source.id]);
    await stopTereo();
  });

  it("records an export ok, with its row count, when its end record fails once", async () => {
    const caller = await grantedCaller();
    vi.mocked(recordExportEnd).mockImplementationOnce(outage);
    const { sink, ends } = sinkOf();
    await exportCustomers(caller, sink);
    expect(ends).toEqual([{ status: "complete", rows: 3 }]);
    expect(await closedRun(caller)).toMatchObject({
      outcome: "ok",
      rowCount: 3,
      errorCode: null,
    });
    expect(recordExportEnd).toHaveBeenCalledTimes(2);
  });

  it("records a failed export with its code when its end record fails once", async () => {
    const caller = await grantedCaller();
    vi.mocked(recordExportEnd).mockImplementationOnce(outage);
    const broken = new Error("socket gone");
    const { sink } = sinkOf(() => Promise.reject(broken));
    await expect(exportCustomers(caller, sink)).rejects.toBe(broken);
    expect(await closedRun(caller)).toMatchObject({
      outcome: "failed",
      errorCode: "server_error",
    });
    expect(recordExportEnd).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of attempts, never failing the export, and leaves the run for the sweep", async () => {
    const caller = await grantedCaller();
    vi.mocked(recordExportEnd).mockImplementation(outage);
    try {
      const { sink, ends } = sinkOf();
      const began = Date.now();
      await exportCustomers(caller, sink);
      // The export's end does not wait for the attempts that follow.
      expect(Date.now() - began).toBeLessThan(2000);
      expect(ends).toEqual([{ status: "complete", rows: 3 }]);
      await new Promise((resolve) => setTimeout(resolve, RETRIES_MS));
      expect(recordExportEnd).toHaveBeenCalledTimes(ATTEMPTS);
      const [run] = await runsOf([caller.userId]);
      expect(run).toMatchObject({ outcome: "running" });
    } finally {
      vi.mocked(recordExportEnd).mockReset();
    }
  });

  it("stops trying once the run is no longer running", async () => {
    const caller = await grantedCaller();
    const actual = await vi.importActual<
      typeof import("../../engine/record.js")
    >("../../engine/record.js");
    // The first attempt fails after the sweep has closed the run.
    vi.mocked(recordExportEnd).mockImplementationOnce(async (runId, start) => {
      await actual.recordInterruptedExport(
        {
          id: runId,
          userId: caller.userId,
          sourceId: start.sourceId,
          rowCount: null,
          createdAt: new Date(),
        },
        new Date()
      );
      return outage();
    });
    await exportCustomers(caller, sinkOf().sink);
    expect(await closedRun(caller)).toMatchObject({
      outcome: "failed",
      errorCode: "interrupted",
    });
    await new Promise((resolve) => setTimeout(resolve, RETRIES_MS));
    expect(recordExportEnd).toHaveBeenCalledTimes(2);
  });
});
