// @module-tag int
// @module-tag platform
// @module-tag job
import type { RunOutcome } from "../../../prisma/generated/client/index.js";
import { sourceSettings, uniqueSlug } from "../support/sources.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { auditRows, removeSources } from "../support/sources.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { removeRunsOf } from "../support/queries.js";
import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  INTERRUPTED_AFTER_MS,
  closeInterruptedExports,
  deleteOldRuns,
  runHousekeeping,
  startRunsHousekeepingJob,
} from "../../jobs/runsHousekeeping.js";
import {
  recordExportEnd,
  recordInterruptedExport,
} from "../../engine/record.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Far in the past, so the sweeps cannot touch runs other tests create.
const NOW = new Date("2020-06-01T12:00:00.000Z");

describe("runs housekeeping", () => {
  let sourceId: string;
  const users: string[] = [];

  /** A run of a fresh user, created `ageMs` before NOW. */
  const newRun = async (
    ageMs: number,
    extra: {
      outcome?: RunOutcome;
      entryPoint?: "api" | "export";
      rowCount?: number | null;
    } = {}
  ) => {
    const userId = randomUUID();
    users.push(userId);
    return prisma.queryRun.create({
      data: {
        userId,
        sourceId,
        entryPoint: extra.entryPoint ?? "export",
        query: { from: "customers" },
        durationMs: 0,
        rowCount: extra.rowCount ?? null,
        outcome: extra.outcome ?? "running",
        errorCode: null,
        createdAt: new Date(NOW.getTime() - ageMs),
      },
    });
  };
  const reload = (id: string) =>
    prisma.queryRun.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await initializeTereo();
    sourceId = randomUUID();
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: uniqueSlug("house"),
        name: "Housekeeping test",
        type: "postgres",
        sealedSettings: sealSettings(sourceSettings("ro"), sourceId) as object,
        schemas: ["sales"],
        createdBy: randomUUID(),
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await redis.del("zeteo:job:runs-housekeeping");
    await removeRunsOf(users.splice(0));
  });
  afterAll(async () => {
    await removeSources([sourceId]);
    await stopTereo();
  });

  describe("closeInterruptedExports", () => {
    it("closes an export running 16 minutes with an entry by its user, and leaves one running 5 minutes", async () => {
      const old = await newRun(16 * MINUTE, { rowCount: 42 });
      const recent = await newRun(5 * MINUTE);
      expect(await closeInterruptedExports(NOW)).toBe(1);

      expect(await reload(old.id)).toMatchObject({
        outcome: "failed",
        errorCode: "interrupted",
        rowCount: 42,
        durationMs: 10 * MINUTE,
      });
      expect((await reload(recent.id)).outcome).toBe("running");
      const audit = (await auditRows(old.id)).map((r) => r.payload);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        userId: old.userId,
        entityType: "query_run",
        metadata: {
          event: "zeteo.export.run",
          outcome: "failed",
          error_code: "interrupted",
          row_count: 42,
          source_id: sourceId,
        },
      });
      expect(await auditRows(recent.id)).toHaveLength(0);
    });

    it("keeps a null row count, caps the duration at the export limit and ignores queries and closed exports", async () => {
      const old = await newRun(3 * DAY);
      const query = await newRun(3 * DAY, { entryPoint: "api" });
      const done = await newRun(3 * DAY, { outcome: "ok", rowCount: 3 });
      expect(INTERRUPTED_AFTER_MS).toBeGreaterThan(10 * MINUTE);
      expect(await closeInterruptedExports(NOW)).toBe(1);
      expect(await reload(old.id)).toMatchObject({
        rowCount: null,
        durationMs: 600_000,
      });
      expect((await reload(query.id)).outcome).toBe("running");
      expect((await reload(done.id)).outcome).toBe("ok");
    });

    it("leaves exactly one final state when the export ends while the sweep runs", async () => {
      const run = await newRun(16 * MINUTE);
      const [ended] = await Promise.all([
        recordExportEnd(
          run.id,
          { caller: { userId: run.userId }, sourceId },
          {
            durationMs: 1,
            rowCount: 7,
            outcome: "ok",
            errorCode: null,
            truncated: false,
          }
        ),
        closeInterruptedExports(NOW),
      ]);
      const final = await reload(run.id);
      const audit = (await auditRows(run.id)).map((r) => r.payload);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata.outcome).toBe(final.outcome);
      expect(final.outcome).toBe(ended ? "ok" : "failed");
    });

    const endOk = (runId: string, userId: string) =>
      recordExportEnd(
        runId,
        { caller: { userId }, sourceId },
        {
          durationMs: 1,
          rowCount: 7,
          outcome: "ok",
          errorCode: null,
          truncated: false,
        }
      );
    const exportRunEntries = async (id: string) =>
      (await auditRows(id)).filter(
        (r) => r.payload.metadata.event === "zeteo.export.run"
      );

    it("does not overwrite an export that ended first, from the stale row the sweep read", async () => {
      const stale = await newRun(16 * MINUTE);
      expect(await endOk(stale.id, stale.userId)).toBe(true);
      expect(await recordInterruptedExport({ ...stale, sourceId }, NOW)).toBe(
        false
      );
      expect(await reload(stale.id)).toMatchObject({
        outcome: "ok",
        rowCount: 7,
      });
      expect(await exportRunEntries(stale.id)).toHaveLength(1);
    });

    it("leaves the sweep's close in place when the export ends after it", async () => {
      const stale = await newRun(16 * MINUTE);
      expect(await recordInterruptedExport({ ...stale, sourceId }, NOW)).toBe(
        true
      );
      expect(await endOk(stale.id, stale.userId)).toBe(false);
      expect(await reload(stale.id)).toMatchObject({
        outcome: "failed",
        errorCode: "interrupted",
      });
      const entries = await exportRunEntries(stale.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.payload.metadata.outcome).toBe("failed");
    });

    it("closes nothing a second time", async () => {
      await newRun(16 * MINUTE);
      expect(await closeInterruptedExports(NOW)).toBe(1);
      expect(await closeInterruptedExports(NOW)).toBe(0);
    });
  });

  describe("deleteOldRuns", () => {
    it("deletes runs older than the retention and keeps newer ones, and a running one however old", async () => {
      const old = await newRun(91 * DAY, { outcome: "ok" });
      const oldQuery = await newRun(200 * DAY, {
        outcome: "failed",
        entryPoint: "api",
      });
      const recent = await newRun(89 * DAY, { outcome: "ok" });
      const running = await newRun(200 * DAY);
      expect(await deleteOldRuns(90, NOW)).toBe(2);
      const left = await prisma.queryRun.findMany({
        where: { id: { in: [old.id, oldQuery.id, recent.id, running.id] } },
        select: { id: true },
      });
      expect(left.map((r) => r.id).sort()).toEqual(
        [recent.id, running.id].sort()
      );
      expect(await auditRows(old.id)).toHaveLength(0);
    });

    it("deletes in batches until none are left", async () => {
      const userId = randomUUID();
      users.push(userId);
      const at = new Date(NOW.getTime() - 100 * DAY);
      await prisma.queryRun.createMany({
        data: Array.from({ length: 2300 }, () => ({
          userId,
          sourceId,
          entryPoint: "api" as const,
          query: {},
          durationMs: 0,
          outcome: "ok" as const,
          createdAt: at,
        })),
      });
      expect(await deleteOldRuns(90, NOW)).toBe(2300);
    });

    it("keeps everything with a retention of 0", async () => {
      const old = await newRun(1000 * DAY, { outcome: "ok" });
      expect(await deleteOldRuns(0, NOW)).toBe(0);
      expect((await reload(old.id)).id).toBe(old.id);
    });
  });

  describe("runHousekeeping", () => {
    it("does nothing while another replica holds the lock", async () => {
      const old = await newRun(16 * MINUTE);
      await redis.set("zeteo:job:runs-housekeeping", "other", "EX", 60);
      await runHousekeeping(NOW);
      expect((await reload(old.id)).outcome).toBe("running");
      expect(await redis.get("zeteo:job:runs-housekeeping")).toBe("other");
    });

    it("skips the tick, logged and not thrown, when Redis fails", async () => {
      const old = await newRun(16 * MINUTE);
      vi.spyOn(redis, "set").mockRejectedValue(new Error("redis down"));
      const warn = vi.spyOn(logger, "warn");
      await expect(runHousekeeping(NOW)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      expect((await reload(old.id)).outcome).toBe("running");
    });

    it("closes interrupted exports and releases the lock", async () => {
      const old = await newRun(16 * MINUTE);
      await runHousekeeping(NOW);
      expect((await reload(old.id)).errorCode).toBe("interrupted");
      expect(await redis.get("zeteo:job:runs-housekeeping")).toBeNull();
    });
  });

  describe("startRunsHousekeepingJob", () => {
    it("sweeps after its first delay, and not after the stop function resolves", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
      });
      // A held lock: the ticks do nothing but touch the lock.
      const set = vi
        .spyOn(redis, "set")
        .mockResolvedValue(null as unknown as "OK");
      const stop = startRunsHousekeepingJob();
      await vi.advanceTimersByTimeAsync(121_000);
      expect(set).toHaveBeenCalledTimes(1);
      await expect(stop()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(3 * 3_600_000);
      expect(set).toHaveBeenCalledTimes(1);
    });
  });
});
