// @module-tag int
// @module-tag job
// @module-tag platform
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { createUploadSource } from "../../uploads/service.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import * as refresh from "../../catalog/refresh.js";
import { prisma } from "../../utils/db/prisma.js";
import { db } from "../../utils/db/index.js";
import { redis } from "../../utils/redis.js";
import { randomUUID } from "crypto";
import env from "../../env.js";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  REFRESH_CHECK_INTERVAL_MS,
  refreshStaleSources,
  startRefreshJob,
} from "../../jobs/refreshSources.js";
import {
  FakeSpreadsheet,
  serveSheets,
  stageFakeSheet,
} from "../support/googleSheets.js";
import {
  removeUploadSourcesOf,
  seedUploadSource,
  uploadTablesOf,
} from "../support/uploads.js";
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

const google = vi.hoisted(() => ({
  getSpreadsheet: vi.fn(),
  googleClient: vi.fn(),
}));

vi.mock("../../google/handler.js", () => ({
  googleClient: () => google.googleClient(),
  sheetsApi: {
    getSpreadsheet: (...args: unknown[]) => google.getSpreadsheet(...args),
  },
  stopGoogleHandler: vi.fn(),
}));

const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T12:00:00.000Z");

describe("refreshStaleSources", () => {
  const created: string[] = [];

  /** A source last refreshed `hoursAgo` hours before NOW. */
  const newSource = async (
    hoursAgo: number | null,
    extra: { archivedAt?: Date; status?: "active" | "unreachable" } = {}
  ) => {
    const id = randomUUID();
    created.push(id);
    await prisma.source.create({
      data: {
        id,
        slug: uniqueSlug("job"),
        name: "Job test",
        type: "postgres",
        sealedSettings: sealSettings(sourceSettings("ro"), id) as object,
        schemas: ["sales"],
        createdBy: randomUUID(),
        lastRefreshedAt:
          hoursAgo === null ? null : new Date(NOW.getTime() - hoursAgo * HOUR),
        ...extra,
      },
    });
    return id;
  };

  beforeAll(async () => {
    await initializeTereo();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAllSourcePools();
    for (const id of created) await redis.del(`zeteo:refresh:${id}`);
    await removeSources(created.splice(0));
  });
  afterAll(async () => {
    await stopTereo();
  });

  it("refreshes a source refreshed 25 hours ago and leaves one refreshed an hour ago", async () => {
    const stale = await newSource(25);
    const fresh = await newSource(1);
    const never = await newSource(null);
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(NOW);
    const called = spy.mock.calls.map(([id]) => id);
    expect(called).toContain(stale);
    expect(called).toContain(never);
    expect(called).not.toContain(fresh);
    expect(
      (await prisma.source.findUniqueOrThrow({ where: { id: stale } }))
        .lastRefreshedAt
    ).not.toEqual(new Date(NOW.getTime() - 25 * HOUR));
    expect(await prisma.sourceTable.count({ where: { sourceId: stale } })).toBe(
      13
    );
  });

  it("skips upload sources, never refreshed or not", async () => {
    const files = [null, 30].map(async (hoursAgo) => {
      const id = randomUUID();
      created.push(id);
      await prisma.source.create({
        data: {
          id,
          slug: uniqueSlug("job"),
          name: "File job test",
          type: "upload",
          ownerId: randomUUID(),
          sealedSettings: {},
          schemas: [],
          createdBy: randomUUID(),
          lastRefreshedAt:
            hoursAgo === null
              ? null
              : new Date(NOW.getTime() - hoursAgo * HOUR),
        },
      });
      return id;
    });
    const ids = await Promise.all(files);
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(NOW);
    const called = spy.mock.calls.map(([id]) => id);
    for (const id of ids) expect(called).not.toContain(id);
  });

  it("skips archived sources", async () => {
    const archived = await newSource(30, { archivedAt: new Date() });
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(NOW);
    expect(spy.mock.calls.map(([id]) => id)).not.toContain(archived);
  });

  it("skips a source whose Redis lock another replica holds", async () => {
    const held = await newSource(30);
    const free = await newSource(30);
    await redis.set(`zeteo:refresh:${held}`, "other-replica", "EX", 900);
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(NOW);
    const called = spy.mock.calls.map(([id]) => id);
    expect(called).not.toContain(held);
    expect(called).toContain(free);
    expect(await redis.get(`zeteo:refresh:${held}`)).toBe("other-replica");
    expect(await prisma.sourceTable.count({ where: { sourceId: held } })).toBe(
      0
    );
  });

  it("releases its lock when done, with a 15 minute expiry while held", async () => {
    const id = await newSource(30);
    let ttl = -1;
    vi.spyOn(refresh, "refreshSource").mockImplementation(async () => {
      ttl = await redis.ttl(`zeteo:refresh:${id}`);
      return {
        tables: { added: 0, missing: 0, restored: 0 },
        columns: { added: 0, changed: 0, missing: 0, restored: 0 },
        relations: { added: 0, missing: 0, restored: 0 },
      };
    });
    await refreshStaleSources(NOW);
    expect(ttl).toBeGreaterThan(800);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(await redis.get(`zeteo:refresh:${id}`)).toBeNull();
  });

  it("goes on to the next source when one throws", async () => {
    const broken = await newSource(30);
    const next = await newSource(29);
    const real = refresh.refreshSource;
    const spy = vi
      .spyOn(refresh, "refreshSource")
      .mockImplementation((id, actor) =>
        id === broken ? Promise.reject(new Error("boom")) : real(id, actor)
      );
    await expect(refreshStaleSources(NOW)).resolves.toBeUndefined();
    expect(spy.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([broken, next])
    );
    expect(await redis.get(`zeteo:refresh:${broken}`)).toBeNull();
    expect(await prisma.sourceTable.count({ where: { sourceId: next } })).toBe(
      13
    );
  });

  it("skips a source another replica refreshed after it was listed", async () => {
    const id = await newSource(30);
    const listed = await prisma.source.findUniqueOrThrow({ where: { id } });
    await prisma.source.update({
      where: { id },
      data: { lastRefreshedAt: new Date(NOW.getTime() - HOUR) },
    });
    vi.spyOn(db.sources, "listDue").mockResolvedValue([listed]);
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(NOW);
    expect(spy).not.toHaveBeenCalled();
    expect(await redis.get(`zeteo:refresh:${id}`)).toBeNull();
  });

  it("skips a source archived after it was listed", async () => {
    const id = await newSource(30);
    const listed = await prisma.source.findUniqueOrThrow({ where: { id } });
    await prisma.source.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    vi.spyOn(db.sources, "listDue").mockResolvedValue([listed]);
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(NOW);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("refreshStaleSources of Google Sheets sources", () => {
  const MINUTE = 60_000;
  const ownerId = randomUUID();
  const owner = {
    userId: ownerId,
    organizationId: null,
    permissions: [DATA_READ, UPLOADS_WRITE],
    isServiceAccount: false,
  };
  const sheets = new Map<string, FakeSpreadsheet>();
  const made: string[] = [];

  /** A Sheets source (interval 60 min) whose last sync attempt was `minutesAgo` before `now`. */
  const makeSheets = async (minutesAgo: number, now: Date) => {
    const sheet = new FakeSpreadsheet(`sheet-${randomUUID()}`, [
      {
        sheetId: 1,
        title: "Costs",
        rows: [
          ["item", "amount"],
          ["rent", "1200"],
        ],
      },
    ]);
    sheets.set(sheet.id, sheet);
    const staged = await stageFakeSheet(ownerId, sheet);
    const view = await createUploadSource(owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Book",
      tables: [{ key: "sheet:1" }],
    });
    made.push(view.id);
    await setAttempt(view.id, new Date(now.getTime() - minutesAgo * MINUTE));
    return { sheet, id: view.id };
  };

  const setAttempt = (id: string, at: Date) =>
    prisma.source.update({
      where: { id },
      data: { lastSyncAttemptAt: at, lastRefreshedAt: at },
    });

  const rowCount = async (id: string) =>
    (await uploadTablesOf(id))[0]!.row_count;

  beforeAll(async () => {
    await initializeTereo();
  });
  beforeEach(() => {
    serveSheets(google, sheets);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of made.splice(0)) await redis.del(`zeteo:refresh:${id}`);
    sheets.clear();
    await removeUploadSourcesOf([ownerId]);
  });
  afterAll(async () => {
    await prisma.source.deleteMany({ where: { createdBy: ownerId } });
    await stopTereo();
  });

  it("syncs a Sheets source whose interval has passed", async () => {
    const now = new Date();
    const { sheet, id } = await makeSheets(61, now);
    sheet.tab(1).rows.push(["food", "300"]);
    await refreshStaleSources(now);
    expect(await rowCount(id)).toBe(2);
    const row = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(row.lastSyncError).toBeNull();
    expect(row.lastSyncAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      now.getTime()
    );
  });

  it("lists no Sheets source while uploads are off", async () => {
    const now = new Date();
    const { id } = await makeSheets(61, now);
    const cutoff = new Date(now.getTime() - 24 * HOUR);
    expect((await db.sources.listDue(cutoff, now)).map((s) => s.id)).toContain(
      id
    );
    const url = env.UPLOADS_READER_URL;
    env.UPLOADS_READER_URL = undefined;
    try {
      expect(
        (await db.sources.listDue(cutoff, now)).map((s) => s.id)
      ).not.toContain(id);
    } finally {
      env.UPLOADS_READER_URL = url;
    }
  });

  it("skips one synced within its interval", async () => {
    const now = new Date();
    const { sheet, id } = await makeSheets(30, now);
    sheet.tab(1).rows.push(["food", "300"]);
    const spy = vi.spyOn(refresh, "refreshSource");
    await refreshStaleSources(now);
    expect(spy.mock.calls.map(([called]) => called)).not.toContain(id);
    expect(await rowCount(id)).toBe(1);
  });

  it("retries a failing source only after its interval", async () => {
    const now = new Date();
    const { sheet, id } = await makeSheets(61, now);
    const healthy = await makeSheets(61, now);
    sheet.failWith = "GGL_0009";
    healthy.sheet.tab(1).rows.push(["food", "300"]);

    // The failure is recorded, and the sweep goes on to the next source.
    await refreshStaleSources(now);
    const failed = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(failed.lastSyncError).toMatchObject({
      tables: [{ name: "costs", code: "sheet_not_accessible" }],
    });
    expect(await rowCount(healthy.id)).toBe(2);

    const spy = vi.spyOn(refresh, "refreshSource");
    const attempt = failed.lastSyncAttemptAt!.getTime();
    await refreshStaleSources(new Date(attempt + 30 * MINUTE));
    expect(spy.mock.calls.map(([called]) => called)).not.toContain(id);
    await refreshStaleSources(new Date(attempt + 61 * MINUTE));
    expect(spy.mock.calls.map(([called]) => called)).toContain(id);
  });

  it("a file-only source: the job skips it", async () => {
    const now = new Date();
    const file = await seedUploadSource({
      ownerId,
      tables: [
        { name: "t", columns: [{ name: "a", type: "text" }], rows: [["1"]] },
      ],
    });
    made.push(file.id);
    await prisma.source.update({
      where: { id: file.id },
      data: { syncIntervalMinutes: 60, lastSyncAttemptAt: null },
    });
    const cutoff = new Date(now.getTime() - 24 * HOUR);
    expect(
      (await db.sources.listDue(cutoff, now)).map((s) => s.id)
    ).not.toContain(file.id);
    const spy = vi.spyOn(refresh, "refreshSource");
    vi.spyOn(db.sources, "listDue").mockResolvedValue([
      await prisma.source.findUniqueOrThrow({ where: { id: file.id } }),
    ]);
    await refreshStaleSources(now);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a source whose only Sheets tab was deleted keeps syncing, and the tab's table revives when the tab returns", async () => {
    const now = new Date();
    const { sheet, id } = await makeSheets(61, now);
    const [table] = await uploadTablesOf(id);
    const tab = sheet.tab(1);
    sheet.tabs = [];

    await refreshStaleSources(now);
    expect((await uploadTablesOf(id))[0]).toMatchObject({
      id: table!.id,
      missing: true,
    });

    // Still due once its interval has passed, though its only table is missing.
    const attempt = (await prisma.source.findUniqueOrThrow({ where: { id } }))
      .lastSyncAttemptAt!;
    const later = new Date(attempt.getTime() + 61 * MINUTE);
    const cutoff = new Date(later.getTime() - 24 * HOUR);
    expect(
      (await db.sources.listDue(cutoff, later)).map((s) => s.id)
    ).toContain(id);

    // A run that finds it still gone ends cleanly.
    await redis.del(`zeteo:refresh:${id}`);
    await refreshStaleSources(later);
    const quiet = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(quiet.lastSyncError).toBeNull();
    expect((await uploadTablesOf(id))[0]!.missing).toBe(true);

    // Undo in Sheets: the tab returns with its sheetId.
    sheet.tabs = [{ ...tab, rows: [...tab.rows, ["food", "300"]] }];
    const again = new Date(quiet.lastSyncAttemptAt!.getTime() + 61 * MINUTE);
    await refreshStaleSources(again);
    expect((await uploadTablesOf(id))[0]).toMatchObject({
      id: table!.id,
      missing: false,
      row_count: 2,
    });
  });

  it("still refreshes database sources after 24h", async () => {
    const now = new Date();
    await makeSheets(30, now);
    const ids = [randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      made.push(id);
      await prisma.source.create({
        data: {
          id,
          slug: uniqueSlug("job"),
          name: "Job test",
          type: "postgres",
          sealedSettings: sealSettings(sourceSettings("ro"), id) as object,
          schemas: ["sales"],
          createdBy: ownerId,
          // 25 hours and 2 hours ago: only the first is due.
          lastRefreshedAt: new Date(now.getTime() - (i === 0 ? 25 : 2) * HOUR),
        },
      });
    }
    const spy = vi.spyOn(refresh, "refreshSource");
    try {
      await refreshStaleSources(now);
      const called = spy.mock.calls.map(([id]) => id);
      expect(called).toContain(ids[0]);
      expect(called).not.toContain(ids[1]);
    } finally {
      await closeAllSourcePools();
      await removeSources(ids);
    }
  });
});

describe("startRefreshJob", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const fakeJob = () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    return vi.spyOn(db.sources, "listDue").mockResolvedValue([]);
  };

  it("sweeps 30 seconds plus jitter after start, then every five minutes, and not after stop", async () => {
    expect(REFRESH_CHECK_INTERVAL_MS).toBe(5 * 60_000);
    const sweeps = fakeJob();
    const stop = startRefreshJob();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sweeps).toHaveBeenCalledTimes(0);
    // 30 s, plus half of the 30 s jitter.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(sweeps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS);
    expect(sweeps).toHaveBeenCalledTimes(2);
    await stop();
    await vi.advanceTimersByTimeAsync(3 * REFRESH_CHECK_INTERVAL_MS);
    expect(sweeps).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the first sweep when stopped before it", async () => {
    const sweeps = fakeJob();
    const stop = startRefreshJob();
    await stop();
    await vi.advanceTimersByTimeAsync(REFRESH_CHECK_INTERVAL_MS);
    expect(sweeps).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
