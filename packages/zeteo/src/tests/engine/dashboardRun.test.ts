// @module-tag int
// @module-tag platform
// @module-tag race
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import type { SourceConnection } from "../../adapters/types.js";
import { TooManyRequestsError } from "../../utils/errors.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { removeSources } from "../support/sources.js";
import { acquireLease } from "../../engine/leases.js";
import { runQuery } from "../../engine/index.js";
import { ENGINES } from "../support/engines.js";
import {
  removePrincipalLimits,
  setPrincipalLimit,
} from "../support/principalLimits.js";
import {
  clearDashboardKeys,
  readerOf,
  removeDashboardsOf,
  runOnDashboard,
  seedDashboardQuery,
  type SeededDashboardQuery,
} from "../support/dashboardRuns.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Counts the runs that reach a source. The engine runs in this process.
const opened = vi.hoisted(() => ({ count: 0 }));

vi.mock(import("../../sources/pools.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withSourceConnection: <T>(
      id: string,
      fn: (conn: SourceConnection) => Promise<T>
    ) => {
      opened.count += 1;
      return actual.withSourceConnection(id, fn);
    },
  };
});

describe("runQuery from a dashboard", () => {
  let source: SeededSource;
  let seeded: SeededDashboardQuery;
  const owner = newQueryUser();
  const viewer = newQueryUser();
  const users = [owner.id, viewer.id];

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(ENGINES[0]!, {}, "dashrun");
    for (const u of [owner, viewer]) {
      await grantTo(u.principal, source.tables.orders!, ["id", "status"]);
    }
    seeded = await seedDashboardQuery(source, owner.id);
  });
  afterEach(async () => {
    await clearDashboardKeys();
    opened.count = 0;
  });
  afterAll(async () => {
    await removePrincipalLimits(users);
    await removeRunsOf(users);
    await removeDashboardsOf([owner.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("runs the same query of two viewers with the same grants once on the source", async () => {
    const [a, b] = await Promise.all([
      runOnDashboard(owner.id, seeded),
      runOnDashboard(viewer.id, seeded),
    ]);
    expect(opened.count).toBe(1);
    expect(b.rows).toEqual(a.rows);
    expect(a.rows.length).toBeGreaterThan(0);
    // Each viewer's run is recorded, against the dashboard.
    expect(a.run_id).toBeDefined();
    expect(b.run_id).toBeDefined();
    const runs = (await runsOf(users)).filter((r) =>
      [a.run_id, b.run_id].includes(r.id)
    );
    expect(runs.map((r) => r.entryPoint)).toEqual(["dashboard", "dashboard"]);
    expect(runs.every((r) => r.dashboardId === seeded.dashboardId)).toBe(true);
  });

  it("serves a second run within the time to live from the cache", async () => {
    const first = await runOnDashboard(owner.id, seeded);
    expect(first.cached_at).toBeUndefined();
    const second = await runOnDashboard(owner.id, seeded);
    expect(opened.count).toBe(1);
    expect(second.cached_at).toEqual(expect.any(String));
    expect(second.rows).toEqual(first.rows);
    expect(second.columns).toEqual(first.columns);
  });

  it("caps rows at the dashboard profile's default", async () => {
    const result = await runOnDashboard(owner.id, seeded);
    expect(result.rows.length).toBeLessThanOrEqual(1000);
  });

  it("waits for a lease held by the viewer's own other run, where an API run is refused", async () => {
    await setPrincipalLimit(viewer.principal, { query_concurrency: 1 });
    const held = await acquireLease(`user:${viewer.id}`, 1, 10_000);
    expect(held).not.toBeNull();
    let settled = false;
    const waiting = runOnDashboard(viewer.id, seeded).finally(() => {
      settled = true;
    });

    await expect(
      runQuery({
        caller: readerOf(viewer.id),
        entryPoint: "api",
        body: seeded.query,
      })
    ).rejects.toMatchObject({
      constructor: TooManyRequestsError,
      code: "too_many_queries",
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);

    await held!.release();
    const result = await waiting;
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("refuses the dashboard option on any other entry point, or without a saved query", async () => {
    await expect(
      runQuery({
        caller: readerOf(owner.id),
        entryPoint: "api",
        body: seeded.query,
        savedQuery: seeded.savedQuery,
        dashboard: { dashboardId: seeded.dashboardId, now: new Date() },
      })
    ).rejects.toThrow(/dashboard/);
    await expect(
      runQuery({
        caller: readerOf(owner.id),
        entryPoint: "dashboard",
        body: seeded.query,
        dashboard: { dashboardId: seeded.dashboardId, now: new Date() },
      })
    ).rejects.toThrow(/dashboard/);
  });
});
