// @module-tag int
// @module-tag platform
import { DATA_EXPORT, DATA_READ } from "../../definitions/tereoDeclaration.js";
import { calendarWriteToken, resetCalendar } from "../support/calendar.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { clearDashboardKeys } from "../support/dashboardRuns.js";
import type { MetricRow } from "../../grants/visibleCatalog.js";
import { withTimeFilter } from "../../dashboards/timeRange.js";
import { clearCalendarCache } from "../../calendar/service.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { BASE_URL, fetchJson } from "../support/http.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ORDER_TIMES } from "../support/businessDays.js";
import { uniqueName } from "../support/savedQueries.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { runExport } from "../../engine/export.js";
import { prisma } from "../../utils/db/index.js";
import { runQuery } from "../../engine/index.js";
import { randomUUID } from "node:crypto";
import {
  businessDays,
  businessDaysElapsed,
  businessDaysIn,
  DEFAULT_CALENDAR,
} from "../../calendar/calendar.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// Metric queries on both engines: measures of two tables (orders by its
// timestamp, ad_spend by its date) bucketed by month, each by its own date
// column, combined per period. The fixture has orders January to June and
// spend January to May and in July.

/** Each month's revenue and spend, as the fixture holds them. */
const MONTHS: [period: string, revenue: string | null, spend: string | null][] =
  [
    ["2026-01-01T00:00:00.000Z", "260.50", "150.00"],
    ["2026-02-01T00:00:00.000Z", "1299.99", "200.00"],
    ["2026-03-01T00:00:00.000Z", "80.25", "25.00"],
    ["2026-04-01T00:00:00.000Z", "658.50", "40.00"],
    ["2026-05-01T00:00:00.000Z", "443.33", "80.00"],
    ["2026-06-01T00:00:00.000Z", "1011.99", null],
    ["2026-07-01T00:00:00.000Z", null, "60.00"],
  ];

const iso = (v: unknown) => new Date(v as string).toISOString();

describeEachEngine("runQuery: metric queries", (engine) => {
  const user = newQueryUser();
  const caller: Caller = {
    userId: user.id,
    organizationId: null,
    permissions: [DATA_READ, DATA_EXPORT],
    isServiceAccount: false,
  };
  const author = randomUUID();
  let source: SeededSource;

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

  /** Stores `list` as the source's metrics, in place of any stored before. */
  const storeMetrics = async (list: typeof ALL_METRICS) => {
    await prisma.metric.deleteMany({ where: { sourceId: source.id } });
    await prisma.metric.createMany({
      data: list.map((m) => ({
        id: m.id,
        sourceId: source.id,
        name: m.name,
        description: m.description,
        formula: m.formula as object,
        createdBy: author,
        updatedBy: author,
      })),
    });
  };

  const metric = (name: string, formula: unknown) => ({
    id: randomUUID(),
    name,
    description: `The ${name}`,
    formula: formula as MetricRow["formula"],
  });
  const wide = (n: number) =>
    metric(`wide_${n}`, {
      add: Array.from({ length: 7 }, (_, i) => ({
        measure: `wide${n * 7 + i}`,
      })),
    });
  const ALL_METRICS = [
    wide(0),
    wide(1),
    wide(2),
    metric("roas", { div: [{ measure: "revenue" }, { measure: "spend" }] }),
    metric("landing", {
      add: [
        { measure: "revenue" },
        {
          mul: [
            { measure: "line_count" },
            { businessDaysInMonth: { date: "2026-06-01" } },
          ],
        },
      ],
    }),
    metric("per_business_day", {
      div: [{ measure: "revenue" }, { businessDaysInPeriod: true }],
    }),
    metric("secret_roas", {
      div: [{ measure: "revenue" }, { measure: "secret_spend" }],
    }),
  ];

  const body = (query: object) => ({ source: source.slug, ...query });
  const run = async (query: object, entryPoint: "api" | "mcp" = "api") =>
    (await runQuery({ caller, entryPoint, body: body(query) })).rows;
  const tableRun = async (query: object) =>
    (await runQuery({ caller, entryPoint: "api", body: body(query) })).rows;
  const refusal = (query: object) =>
    runQuery({ caller, entryPoint: "api", body: body(query) }).then(
      () => {
        throw new Error("the query ran");
      },
      (err: unknown) => {
        const e = err as Record<string, unknown>;
        return {
          name: e.name,
          statusCode: e.statusCode,
          code: e.code,
          message: e.message,
          details: e.details,
        };
      }
    );

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 1000 },
      "metrics"
    );
    for (const table of ["orders", "order_lines"]) {
      await grantTo(user.principal, source.tables[table]!, "all");
    }
    // Not `channel`: a measure reading it is not the caller's.
    await grantTo(user.principal, source.tables.ad_spend!, [
      "id",
      "day",
      "cost",
    ]);
    await addMeasure(
      "revenue",
      "orders",
      { sum: "total" },
      {
        dateColumn: "created_at",
      }
    );
    await addMeasure(
      "spend",
      "ad_spend",
      { sum: "cost" },
      {
        dateColumn: "day",
      }
    );
    await addMeasure("undated", "orders", { count: "*" });
    await addMeasure(
      "order_count",
      "orders",
      { count: "*" },
      { dateColumn: "created_at" }
    );
    // 21 measures for three metrics of seven each: one too many to combine.
    for (let i = 0; i < 21; i++) {
      await addMeasure(
        `wide${i}`,
        "orders",
        { sum: "total" },
        {
          dateColumn: "created_at",
        }
      );
    }
    await addMeasure(
      "line_count",
      "order_lines",
      { count: "*" },
      {
        fixed: true,
      }
    );
    // Part measures with the awkward shapes: a calendar function over a
    // column, a fixed measure inside an aggregate, a date column reached
    // through a to-one relation.
    await addMeasure(
      "bd_days",
      "orders",
      { max: { businessDaysInMonth: "created_at" } },
      { dateColumn: "created_at" }
    );
    await addMeasure(
      "revenue_plus_lines",
      "orders",
      { sum: { add: ["total", { measure: "line_count" }] } },
      { dateColumn: "created_at" }
    );
    await addMeasure(
      "lines_by_order_date",
      "order_lines",
      { count: "*" },
      { dateColumn: "orders.created_at" }
    );
    // A measure over the new calendar functions: each order's business day
    // of its month, summed.
    await addMeasure(
      "business_day_sum",
      "orders",
      { sum: { businessDaysElapsed: ["month", "created_at"] } },
      { dateColumn: "created_at" }
    );
    await addMeasure(
      "secret_spend",
      "ad_spend",
      { countDistinct: "channel" },
      { dateColumn: "day" }
    );
    await storeMetrics(ALL_METRICS);
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("gives ROAS by month equal to the two measures run apart, with null where a month is in one table only", async () => {
    const rows = await run({
      metrics: ["roas", "revenue", "spend"],
      bucket: "month",
    });
    // Review Focus 2: June has no spend and July no revenue; neither row is
    // dropped, and neither value is 0.
    expect(rows.map((r) => [iso(r[0]), r[2], r[3]])).toEqual(MONTHS);

    const revenue = await tableRun({
      from: "orders",
      select: [
        { bucket: "month", column: "created_at", as: "m" },
        { measure: "revenue" },
      ],
      groupBy: ["m"],
    });
    const spend = await tableRun({
      from: "ad_spend",
      select: [
        { bucket: "month", column: "day", as: "m" },
        { measure: "spend" },
      ],
      groupBy: ["m"],
    });
    const apart = new Map<string, [unknown, unknown]>();
    for (const [m, v] of revenue) apart.set(iso(m), [v, null]);
    for (const [m, v] of spend) {
      apart.set(iso(m), [apart.get(iso(m))?.[0] ?? null, v]);
    }
    for (const [period, roas, rev, sp] of rows) {
      const [r, s] = apart.get(iso(period))!;
      expect([rev, sp]).toEqual([r, s]);
      expect(roas).toBe(
        r === null || s === null
          ? null
          : (Math.round((Number(r) / Number(s)) * 1e6) / 1e6).toFixed(6)
      );
    }
    expect(rows[0]![1]).toBe("1.736667");
  });

  it("gives one row without a bucket, and a measure alone as the trivial metric", async () => {
    expect(await run({ metrics: ["roas", "revenue", "spend"] })).toEqual([
      ["6.764973", "3754.56", "555.00"],
    ]);
    const trivial = await run({ metrics: ["spend"], bucket: "month" });
    expect(trivial.map((r) => [iso(r[0]), r[1]])).toEqual(
      MONTHS.filter(([, , s]) => s !== null).map(([p, , s]) => [p, s])
    );
  });

  it("computes a fixed measure and a calendar constant in a formula", async () => {
    // revenue + line_count (2) × 22 business days in June 2026.
    expect(await run({ metrics: ["landing", "line_count"] })).toEqual([
      ["3798.56", "2"],
    ]);
    // Fixed measures alone read no table's rows: one row.
    expect(await run({ metrics: ["line_count"] })).toEqual([["2"]]);
    const byMonth = await run({ metrics: ["landing"], bucket: "month" });
    // Its periods are revenue's: a fixed measure has none.
    expect(byMonth.map((r) => r[1])).toEqual(
      MONTHS.filter(([, rev]) => rev !== null).map(([, rev]) =>
        (Number(rev) + 44).toFixed(2)
      )
    );
  });

  it("combines three or more measures, each in its own typed column", async () => {
    const rows = await run({
      metrics: ["revenue", "spend", "order_count", "roas"],
      bucket: "month",
    });
    const counts = [2, 2, 2, 2, 2, 2, null];
    expect(rows.map((r) => [iso(r[0]), r[1], r[2], r[3]])).toEqual(
      MONTHS.map(([p, rev, sp], i) => [
        p,
        rev,
        sp,
        counts[i] === null ? null : String(counts[i]),
      ])
    );
    expect(rows[0]![4]).toBe("1.736667");
    expect(await run({ metrics: ["revenue", "spend", "order_count"] })).toEqual(
      [["3754.56", "555.00", "12"]]
    );
  });

  it("refuses a 21st distinct measure as too_complex", async () => {
    expect(
      await refusal({ metrics: ["wide_0", "wide_1", "wide_2"] })
    ).toMatchObject({
      statusCode: 422,
      code: "too_complex",
      details: { path: ["metrics", 2] },
    });
    const twenty = await run({ metrics: ["wide_0", "wide_1"] });
    expect(twenty).toEqual([
      [(3754.56 * 7).toFixed(2), (3754.56 * 7).toFixed(2)],
    ]);
  });

  it("orders, limits and offsets the result", async () => {
    const rows = await run({
      metrics: ["revenue"],
      bucket: "month",
      orderBy: [{ period: "desc" }],
      limit: 2,
      offset: 1,
    });
    // Revenue's periods, January to June, latest first, after the first.
    expect(rows.map((r) => [iso(r[0]), r[1]])).toEqual([
      ["2026-05-01T00:00:00.000Z", "443.33"],
      ["2026-04-01T00:00:00.000Z", "658.50"],
    ]);
  });

  it("refuses a bucket over a measure with no date column", async () => {
    expect(
      await refusal({ metrics: ["revenue", "undated"], bucket: "month" })
    ).toMatchObject({
      statusCode: 422,
      code: "measure_has_no_date",
      details: { path: ["metrics", 1] },
    });
  });

  it("refuses a metric over a measure the caller cannot see exactly as one that does not exist (Review Focus 3)", async () => {
    const hidden = await refusal({ metrics: ["revenue", "secret_roas"] });
    expect(hidden).toMatchObject({
      code: "not_found_or_not_accessible",
      details: { path: ["metrics", 1] },
    });
    const hiddenMeasure = await refusal({ metrics: ["secret_spend"] });
    await storeMetrics(ALL_METRICS.filter((m) => m.name !== "secret_roas"));
    await prisma.measure.deleteMany({
      where: { sourceId: source.id, name: "secret_spend" },
    });
    try {
      expect(await refusal({ metrics: ["revenue", "secret_roas"] })).toEqual(
        hidden
      );
      expect(await refusal({ metrics: ["secret_spend"] })).toEqual(
        hiddenMeasure
      );
    } finally {
      await storeMetrics(ALL_METRICS);
      await addMeasure(
        "secret_spend",
        "ad_spend",
        { countDistinct: "channel" },
        { dateColumn: "day" }
      );
    }
  });

  it("runs as a saved query, as an MCP query and as an export", async () => {
    const query = body({ metrics: ["roas"], bucket: "quarter" });
    // Q1: 1640.74 / 375; Q2: 2113.82 / 120; Q3: spend but no revenue.
    const expected = [
      ["2026-01-01T00:00:00.000Z", "4.375307"],
      ["2026-04-01T00:00:00.000Z", "17.615167"],
      ["2026-07-01T00:00:00.000Z", null],
    ];
    const shape = (rows: unknown[][]) => rows.map((r) => [iso(r[0]), r[1]]);

    const saved = await prisma.savedQuery.create({
      data: {
        ownerId: user.id,
        sourceId: source.id,
        name: uniqueName(),
        query,
      },
    });
    const ran = await runQuery({
      caller,
      entryPoint: "api",
      body: query,
      savedQuery: { id: saved.id, sourceId: source.id },
    });
    expect(shape(ran.rows)).toEqual(expected);
    expect(ran.columns).toEqual([
      { name: "period", type: "timestamp" },
      { name: "roas", type: "number" },
    ]);

    expect(
      shape(await run({ metrics: ["roas"], bucket: "quarter" }, "mcp"))
    ).toEqual(expected);

    const exported: unknown[][] = [];
    let ended: unknown;
    await runExport(
      { caller, body: query, signal: new AbortController().signal },
      {
        start: async () => {},
        rows: async (batch) => {
          exported.push(...batch);
        },
        end: async (tail) => {
          ended = tail;
        },
      }
    );
    // An export with no orderBy sends its rows in no set order.
    expect(shape(exported).sort()).toEqual([...expected].sort());
    expect(ended).toEqual({ status: "complete", rows: 3 });
  });

  it("takes a dashboard's time range as its range, relative dates in the calendar's zone", async () => {
    const query = body({ metrics: ["revenue", "spend"] });
    const saved = await prisma.savedQuery.create({
      data: {
        ownerId: user.id,
        sourceId: source.id,
        name: uniqueName(),
        query,
      },
    });
    const dashboard = await prisma.dashboard.create({
      data: { ownerId: user.id, name: uniqueName("dashboard") },
    });
    // Half an hour before April in UTC is April 1st in Tokyo.
    const now = new Date("2026-03-31T23:30:00Z");
    const thisMonth = () =>
      runQuery({
        caller,
        entryPoint: "dashboard",
        body: withTimeFilter(query, "range", "this_month"),
        savedQuery: { id: saved.id, sourceId: source.id },
        dashboard: { dashboardId: dashboard.id, now },
      });
    try {
      await clearDashboardKeys();
      // UTC: March. Revenue from created_at's instants, spend from day's dates.
      expect((await thisMonth()).rows).toEqual([["80.25", "25.00"]]);

      const res = await fetchJson(
        "PUT",
        `${BASE_URL}/v1/calendar`,
        calendarWriteToken(),
        {
          working_days: [1, 2, 3, 4, 5],
          holidays: [],
          fiscal_year_start_month: 1,
          time_zone: "Asia/Tokyo",
        }
      );
      expect(res.status).toBe(200);
      clearCalendarCache();
      // Tokyo: April, from 15:00 UTC on 31 March, so order 6 (23:59 UTC on
      // the 31st) is in it; spend from the date 1 April.
      expect((await thisMonth()).rows).toEqual([["733.50", "40.00"]]);
    } finally {
      await resetCalendar();
      await clearDashboardKeys();
    }
  });

  it("buckets part measures with a calendar function over a column, a fixed measure inside an aggregate and a date column through a relation", async () => {
    const rows = await run({
      metrics: ["bd_days", "revenue_plus_lines", "lines_by_order_date"],
      bucket: "month",
    });
    // Business days of each month of 2026 (Monday to Friday, no holidays);
    // revenue plus the fixed line_count (2) for each of the month's two
    // orders; the two lines of order 2, dated by that order's January.
    // July has no orders, so no row.
    expect(
      rows.map((r) => [iso(r[0]), Number(r[1]), r[2], r[3] && Number(r[3])])
    ).toEqual([
      ["2026-01-01T00:00:00.000Z", 22, "264.50", 2],
      ["2026-02-01T00:00:00.000Z", 20, "1303.99", null],
      ["2026-03-01T00:00:00.000Z", 22, "84.25", null],
      ["2026-04-01T00:00:00.000Z", 22, "662.50", null],
      ["2026-05-01T00:00:00.000Z", 21, "447.33", null],
      ["2026-06-01T00:00:00.000Z", 22, "1015.99", null],
    ]);
  });

  it("divides by each period's business days, by month, week and day", async () => {
    const quotient = (revenue: unknown, days: number) =>
      (Math.round((Number(revenue) / days) * 1e6) / 1e6).toFixed(6);
    for (const bucket of ["month", "week", "day"] as const) {
      const rows = await run({
        metrics: ["per_business_day", "revenue"],
        bucket,
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const [period, perDay, revenue] of rows) {
        const days = businessDaysIn(
          DEFAULT_CALENDAR,
          bucket,
          iso(period).slice(0, 10)
        )!;
        // A day that is not a business day divides by 0: null.
        expect(perDay, `${bucket} ${iso(period)}`).toBe(
          days === 0 ? null : quotient(revenue, days)
        );
      }
    }
  });

  it("divides by the range's business days without a bucket, and needs one or the other", async () => {
    expect(
      await run({
        metrics: ["per_business_day", "revenue"],
        range: { gte: { date: "2026-01-01" }, lt: { date: "2026-04-01" } },
      })
    ).toEqual([
      [
        (
          Math.round(
            (1640.74 /
              businessDays(DEFAULT_CALENDAR, "2026-01-01", "2026-03-31")!) *
              1e6
          ) / 1e6
        ).toFixed(6),
        "1640.74",
      ],
    ]);
    for (const range of [undefined, { gte: { date: "2026-01-01" } }]) {
      expect(
        await refusal({ metrics: ["per_business_day"], range })
      ).toMatchObject({
        statusCode: 422,
        code: "invalid_operator",
        message:
          'Metric "per_business_day": businessDaysInPeriod needs the query\'s bucket, or a range with both gte and lt',
        details: { path: ["metrics", 0] },
      });
    }
  });

  it("buckets a measure over the new calendar functions", async () => {
    const rows = await run({ metrics: ["business_day_sum"], bucket: "month" });
    const sums = new Map<string, number>();
    for (const time of Object.values(ORDER_TIMES)) {
      const date = time.slice(0, 10);
      const month = `${date.slice(0, 7)}-01T00:00:00.000Z`;
      sums.set(
        month,
        (sums.get(month) ?? 0) + businessDaysElapsed(DEFAULT_CALENDAR, date)!
      );
    }
    expect(rows.map((r) => [iso(r[0]), Number(r[1])])).toEqual([...sums]);
  });
});
