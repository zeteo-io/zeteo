// @module-tag int
// @module-tag platform
import { SavedQueryNotAccessibleError } from "../../utils/errors.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { WITHHELD_QUERY } from "../../engine/record.js";
import { removeSources } from "../support/sources.js";
import { claim } from "../../engine/recordWindow.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
import {
  ageRecordWindows,
  auditMetadataOf,
  clearDashboardKeys,
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
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const MINUTE = 60_000;
const T0 = new Date("2026-11-17T09:00:00Z").getTime();

describe("claim", () => {
  afterEach(clearDashboardKeys);

  it("is true once per user and fingerprint until the window runs out", async () => {
    const user = randomUUID();
    expect(await claim(user, "fp-a", 60)).toBe(true);
    expect(await claim(user, "fp-a", 60)).toBe(false);
    expect(await claim(user, "fp-b", 60)).toBe(true);
    expect(await claim(randomUUID(), "fp-a", 60)).toBe(true);
    await ageRecordWindows(user, 60 * MINUTE);
    expect(await claim(user, "fp-a", 60)).toBe(true);
  });
});

describe("the recording window of dashboard runs", () => {
  let source: SeededSource;
  let seeded: SeededDashboardQuery;
  let refused: SeededDashboardQuery;
  const owner = newQueryUser();

  /** Moves the clock, the process's and Redis's for the windows, to `minutes` after T0. */
  let at = 0;
  const advanceTo = async (minutes: number) => {
    vi.setSystemTime(T0 + minutes * MINUTE);
    await ageRecordWindows(owner.id, (minutes - at) * MINUTE);
    at = minutes;
  };

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(ENGINES[0]!, {}, "dashrec");
    await grantTo(owner.principal, source.tables.orders!, ["id", "status"]);
    seeded = await seedDashboardQuery(source, owner.id);
    // `total` is not granted: every run of it is refused.
    refused = await seedDashboardQuery(source, owner.id, ["id", "total"]);
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    at = 0;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await clearDashboardKeys();
    await removeRunsOf([owner.id]);
  });
  afterAll(async () => {
    await removeDashboardsOf([owner.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("records a display left running once per window per query: at 0, not at 30, again at 61 minutes", async () => {
    const first = await runOnDashboard(owner.id, seeded);
    expect(first.run_id).toBeDefined();
    expect(first.cached_at).toBeUndefined();

    await advanceTo(30);
    const inside = await runOnDashboard(owner.id, seeded);
    expect(inside.run_id).toBeUndefined();
    expect(inside.rows).toEqual(first.rows);

    await advanceTo(61);
    // Redis's own clock has not moved, so this one comes from the cache.
    const next = await runOnDashboard(owner.id, seeded);
    expect(next.run_id).toBeDefined();
    expect(next.cached_at).toBeDefined();

    const runs = await runsOf([owner.id]);
    expect(runs.map((r) => r.id)).toEqual([first.run_id, next.run_id]);
    for (const run of runs) {
      expect(run).toMatchObject({
        entryPoint: "dashboard",
        savedQueryId: seeded.savedQuery.id,
        dashboardId: seeded.dashboardId,
        outcome: "ok",
      });
    }
    expect(await auditMetadataOf(first.run_id!)).toMatchObject({
      entry_point: "dashboard",
      dashboard_id: seeded.dashboardId,
      saved_query_id: seeded.savedQuery.id,
      cached: false,
    });
    expect(await auditMetadataOf(next.run_id!)).toMatchObject({
      cached: true,
    });
  });

  it("counts each distinct query in its own window", async () => {
    await runOnDashboard(owner.id, seeded);
    const other = await runOnDashboard(owner.id, seeded, {
      ...seeded.query,
      limit: 5,
    });
    expect(other.run_id).toBeDefined();
    expect(await runsOf([owner.id])).toHaveLength(2);
  });

  it("records a refusal once per window, with the query withheld", async () => {
    const refuse = () =>
      expect(runOnDashboard(owner.id, refused)).rejects.toBeInstanceOf(
        SavedQueryNotAccessibleError
      );
    await refuse();
    await advanceTo(30);
    await refuse();
    let runs = await runsOf([owner.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: "refused",
      errorCode: "saved_query_not_accessible",
      query: WITHHELD_QUERY,
      sourceId: null,
      savedQueryId: refused.savedQuery.id,
      dashboardId: refused.dashboardId,
    });

    await advanceTo(61);
    await refuse();
    runs = await runsOf([owner.id]);
    expect(runs).toHaveLength(2);
  });
});
