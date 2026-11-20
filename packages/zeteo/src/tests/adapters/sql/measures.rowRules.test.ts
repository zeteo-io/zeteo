// @module-tag int
// @module-tag platform
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { closeAllSourcePools } from "../../../sources/pools.js";
import { describeEachEngine } from "../../support/engines.js";
import { uniqueName } from "../../support/savedQueries.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../../support/sources.js";
import { prisma } from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  clearDashboardKeys,
  removeDashboardsOf,
  runOnDashboard,
  type SeededDashboardQuery,
} from "../../support/dashboardRuns.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../support/queries.js";

// Measures, fixed measures and metric queries read only the rows the caller's
// row rules keep: a measure's table, a to-one join it reads through, a fixed
// measure used from another table or as a filter value, and each table of a
// metric query. Compared with an admin's result over the same rows.
// (`rows_limited` is asserted once the caller notices land.)

const PAID = { status: { eq: "paid" } };
const SHIPPED = { status: { eq: "shipped" } };

const iso = (v: unknown) => new Date(v as string).toISOString();
const num = (v: unknown) => Number(v);

describeEachEngine("row rules in measures and metrics", (engine) => {
  let source: SeededSource;
  const admin = newQueryUser();
  const paid = newQueryUser();
  const paidToo = newQueryUser();
  const shipped = newQueryUser();
  const eu = newQueryUser();
  const users = [admin, paid, paidToo, shipped, eu];
  const author = randomUUID();

  const addMeasure = async (
    name: string,
    table: string,
    formula: object,
    options: { where?: object; fixed?: boolean; dateColumn?: string } = {}
  ) => {
    await prisma.measure.create({
      data: {
        sourceId: source.id,
        tableId: source.tables[table]!.id,
        name,
        description: `The ${name}`,
        formula,
        ...(options.where ? { where: options.where } : {}),
        fixed: options.fixed ?? false,
        dateColumn: options.dateColumn ?? null,
        createdBy: author,
        updatedBy: author,
      },
    });
  };
  const run = async (token: string, body: Record<string, unknown>) => {
    const res = await postQuery(token, { source: source.slug, ...body });
    if (res.status !== 200) {
      throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.rows as unknown[][];
  };
  const byMonth = (rows: unknown[][]) =>
    new Map(rows.map((r) => [iso(r[0]), r.slice(1).map(String)]));

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(engine, {}, "rulemeasures");
    const { orders, customers, ad_spend } = source.tables;
    for (const t of [orders!, customers!, ad_spend!]) {
      await grantTo(admin.principal, t, "all");
    }
    for (const u of [paid, paidToo]) {
      await grantTo(u.principal, orders!, "all", {
        access: "rule",
        rule: PAID,
      });
      await grantTo(u.principal, customers!, "all");
      await grantTo(u.principal, ad_spend!, "all");
    }
    await grantTo(shipped.principal, orders!, "all", {
      access: "rule",
      rule: SHIPPED,
    });
    await grantTo(shipped.principal, customers!, "all");
    await grantTo(eu.principal, orders!, "all");
    await grantTo(eu.principal, customers!, "all", {
      access: "rule",
      rule: { region: { eq: "EU" } },
    });

    await addMeasure(
      "revenue",
      "orders",
      { sum: "total" },
      { dateColumn: "created_at" }
    );
    await addMeasure(
      "big_revenue",
      "orders",
      { sum: "total" },
      { where: { total: { lt: 100 } } }
    );
    await addMeasure("order_count", "orders", { count: "*" });
    await addMeasure("region_count", "orders", { count: "customers.region" });
    await addMeasure(
      "spend",
      "ad_spend",
      { sum: "cost" },
      { dateColumn: "day" }
    );
    await addMeasure("min_total", "orders", { min: "total" }, { fixed: true });
    await addMeasure(
      "last_created",
      "orders",
      { max: "created_at" },
      { fixed: true }
    );
    await prisma.metric.createMany({
      data: [
        {
          sourceId: source.id,
          name: "roas",
          description: "The roas",
          formula: { div: [{ measure: "revenue" }, { measure: "spend" }] },
          createdBy: author,
          updatedBy: author,
        },
      ],
    });
  });
  afterAll(async () => {
    await removeRunsOf(users.map((u) => u.id));
    await removeDashboardsOf([admin.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("sums a measure over the caller's rows only, as the admin's sum over paid orders", async () => {
    const mine = await run(paid.token, {
      from: "orders",
      select: [{ measure: "revenue" }],
    });
    const theirs = await run(admin.token, {
      from: "orders",
      select: [{ measure: "revenue" }],
      where: PAID,
    });
    const all = await run(admin.token, {
      from: "orders",
      select: [{ measure: "revenue" }],
    });
    expect(num(mine[0]![0])).toBe(num(theirs[0]![0]));
    expect(num(mine[0]![0])).not.toBe(num(all[0]![0]));
  });

  it("applies a measure's own where together with the rule", async () => {
    const mine = await run(paid.token, {
      from: "orders",
      select: [{ measure: "big_revenue" }],
    });
    const theirs = await run(admin.token, {
      from: "orders",
      select: [{ sum: "total" }],
      where: { and: [PAID, { total: { lt: 100 } }] },
    });
    const own = await run(admin.token, {
      from: "orders",
      select: [{ measure: "big_revenue" }],
    });
    expect(num(mine[0]![0])).toBe(num(theirs[0]![0]));
    expect(num(mine[0]![0])).toBeLessThan(num(own[0]![0]));
  });

  it("reads a to-one column through a rule on the joined table, keeping the orders", async () => {
    const rows = await run(eu.token, {
      from: "orders",
      select: [{ measure: "order_count" }, { measure: "region_count" }],
    });
    // Customer 2 (US) is hidden: its 4 orders stay, its region reads null.
    expect(rows.map((r) => r.map(num))).toEqual([[12, 8]]);
  });

  it("evaluates a fixed measure over the caller's rows, from another table too", async () => {
    const [paidMin] = await run(admin.token, {
      from: "orders",
      select: [{ min: "total" }],
      where: PAID,
    });
    const own = await run(paid.token, {
      from: "orders",
      select: [{ measure: "min_total" }],
    });
    expect(num(own[0]![0])).toBe(num(paidMin![0]));
    expect(num(own[0]![0])).not.toBe(5.25);
    // The query's own table (customers) has no rule; the measure's does.
    const apart = await run(paid.token, {
      from: "customers",
      select: [{ measure: "min_total" }],
      limit: 1,
    });
    expect(num(apart[0]![0])).toBe(num(paidMin![0]));

    const [lastShipped] = await run(admin.token, {
      from: "orders",
      select: [{ max: "created_at" }],
      where: SHIPPED,
    });
    const last = await run(shipped.token, {
      from: "customers",
      select: [{ measure: "last_created" }],
      limit: 1,
    });
    expect(iso(last[0]![0])).toBe(iso(lastShipped![0]));
  });

  it("filters by a fixed measure's rule-filtered value", async () => {
    // Paid totals are 10, 250.5, 1200, 75, 640.1, 410, 999.99: the filtered
    // minimum is 10, so order 1 drops out; the unfiltered 5.25 would keep it.
    const rows = await run(paid.token, {
      from: "orders",
      select: ["id"],
      where: { total: { gt: { measure: "min_total" } } },
    });
    expect(rows.map((r) => num(r[0])).sort((a, b) => a - b)).toEqual([
      2, 4, 6, 8, 10, 12,
    ]);
  });

  it("gives a metric query's per-period values over the caller's rows only", async () => {
    const mine = await run(paid.token, {
      metrics: ["revenue"],
      bucket: "month",
    });
    const theirs = await run(admin.token, {
      from: "orders",
      select: [
        { bucket: "month", column: "created_at", as: "m" },
        { measure: "revenue" },
      ],
      where: PAID,
      groupBy: ["m"],
    });
    expect(byMonth(mine)).toEqual(byMonth(theirs));
    expect(mine.length).toBe(6);

    const ranged = await run(paid.token, {
      metrics: ["revenue"],
      range: { gte: { date: "2026-01-01" }, lt: { date: "2026-04-01" } },
    });
    expect(ranged.map((r) => num(r[0]))).toEqual([1535.5]);
  });

  it("applies the rule to the rule table's part of a combining metric only", async () => {
    const mine = await run(paid.token, {
      metrics: ["roas", "revenue", "spend"],
      bucket: "month",
    });
    const revenue = await run(admin.token, {
      from: "orders",
      select: [
        { bucket: "month", column: "created_at", as: "m" },
        { measure: "revenue" },
      ],
      where: PAID,
      groupBy: ["m"],
    });
    const spend = await run(admin.token, {
      from: "ad_spend",
      select: [
        { bucket: "month", column: "day", as: "m" },
        { measure: "spend" },
      ],
      groupBy: ["m"],
    });
    const rev = byMonth(revenue);
    const sp = byMonth(spend);
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      const key = iso(row[0]);
      expect([String(row[2] ?? "null"), String(row[3] ?? "null")]).toEqual([
        rev.get(key)?.[0] ?? "null",
        sp.get(key)?.[0] ?? "null",
      ]);
    }
  });

  it("gives dashboard viewers with different rules their own metric values, not from one cache", async () => {
    const query = {
      source: source.slug,
      metrics: ["revenue"],
      bucket: "month",
    };
    const saved = await prisma.savedQuery.create({
      data: {
        ownerId: admin.id,
        sourceId: source.id,
        name: uniqueName(),
        query,
      },
      select: { id: true },
    });
    const dashboard = await prisma.dashboard.create({
      data: { ownerId: admin.id, name: uniqueName("dashboard") },
      select: { id: true },
    });
    const seeded = {
      savedQuery: { id: saved.id, sourceId: source.id },
      dashboardId: dashboard.id,
      query,
    } as unknown as SeededDashboardQuery;
    await clearDashboardKeys();
    const a = await runOnDashboard(paid.id, seeded);
    const b = await runOnDashboard(shipped.id, seeded);
    const c = await runOnDashboard(paidToo.id, seeded);
    expect(b.cached_at).toBeUndefined();
    expect(byMonth(a.rows as unknown[][])).not.toEqual(
      byMonth(b.rows as unknown[][])
    );
    const shippedTotal = (b.rows as unknown[][]).reduce(
      (s, r) => s + num(r[1]),
      0
    );
    expect(shippedTotal).toBeCloseTo(99.99 + 18.4 + 12, 2);
    expect(byMonth(c.rows as unknown[][])).toEqual(
      byMonth(a.rows as unknown[][])
    );
    await clearDashboardKeys();
  });
});
