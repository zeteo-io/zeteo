// @module-tag int
// @module-tag platform
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import type { SourceConnection } from "../../adapters/types.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import {
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

// The dashboard cache and shared execution are keyed on the plan, which holds
// each viewer's resolved row rule: viewers share a result only when their
// rules resolve the same.

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

describe("a dashboard panel under row rules", () => {
  let source: SeededSource;
  let seeded: SeededDashboardQuery;
  const owner = newQueryUser();
  const paidA = newQueryUser();
  const paidB = newQueryUser();
  const shipped = newQueryUser();
  const users = [owner, paidA, paidB, shipped];

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(ENGINES[0]!, {}, "dashrules");
    const orders = source.tables.orders!;
    await grantTo(owner.principal, orders, ["id", "status"]);
    for (const u of [paidA, paidB]) {
      await grantTo(u.principal, orders, ["id", "status"], {
        access: "rule",
        rule: { status: { eq: "paid" } },
      });
    }
    await grantTo(shipped.principal, orders, ["id", "status"], {
      access: "rule",
      rule: { status: { eq: "shipped" } },
    });
    seeded = await seedDashboardQuery(source, owner.id);
  });
  afterEach(async () => {
    await clearDashboardKeys();
    opened.count = 0;
  });
  afterAll(async () => {
    await removeRunsOf(users.map((u) => u.id));
    await removeDashboardsOf([owner.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("gives viewers with different rules their own rows, the second not from the cache", async () => {
    const first = await runOnDashboard(paidA.id, seeded);
    const second = await runOnDashboard(shipped.id, seeded);
    expect(opened.count).toBe(2);
    expect(second.cached_at).toBeUndefined();
    expect(first.rows.length).toBeGreaterThan(0);
    expect(second.rows.length).toBeGreaterThan(0);
    expect(first.rows.every((r) => r[1] === "paid")).toBe(true);
    expect(second.rows.every((r) => r[1] === "shipped")).toBe(true);
  });

  it("serves no viewer with a rule from an unlimited viewer's cached result", async () => {
    const all = await runOnDashboard(owner.id, seeded);
    const limited = await runOnDashboard(paidA.id, seeded);
    expect(opened.count).toBe(2);
    expect(limited.cached_at).toBeUndefined();
    expect(limited.rows.length).toBeLessThan(all.rows.length);
  });

  it("shares one execution between viewers whose rules resolve the same", async () => {
    const [a, b] = await Promise.all([
      runOnDashboard(paidA.id, seeded),
      runOnDashboard(paidB.id, seeded),
    ]);
    expect(opened.count).toBe(1);
    expect(b.rows).toEqual(a.rows);
    expect(a.rows.every((r) => r[1] === "paid")).toBe(true);
  });
});
