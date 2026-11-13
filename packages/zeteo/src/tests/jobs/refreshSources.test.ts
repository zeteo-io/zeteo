// @module-tag int
// @module-tag job
// @module-tag platform
import { refreshStaleSources } from "../../jobs/refreshSources.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import * as refresh from "../../catalog/refresh.js";
import { prisma } from "../../utils/db/prisma.js";
import { redis } from "../../utils/redis.js";
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
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
      5
    );
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
      5
    );
  });
});
