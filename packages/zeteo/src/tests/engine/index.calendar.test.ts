// @module-tag int
// @module-tag platform
import { calendarWriteToken, resetCalendar } from "../support/calendar.js";
import { ZONED_CALENDAR, ZONED_EVENTS } from "../support/zonedGrouping.js";
import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { clearDashboardKeys } from "../support/dashboardRuns.js";
import { withTimeFilter } from "../../dashboards/timeRange.js";
import { clearCalendarCache } from "../../calendar/service.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../support/http.js";
import { uniqueName } from "../support/savedQueries.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/index.js";
import { runQuery } from "../../engine/index.js";
import { randomUUID } from "node:crypto";
import {
  businessDaysIn,
  localDate,
  periodStart,
  type BusinessUnit,
} from "../../calendar/calendar.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// Grouping in the calendar's zone, end to end on both engines: a metric
// query's periods, a range and a dashboard's time range agree on which local
// day an instant is. `probe.zoned_events` holds instants either side of
// midnight in Los Angeles; the calendar is Los Angeles with a February fiscal
// year.

/** `probe.zoned_events.amount` by id. */
const AMOUNTS: Record<number, number> = {
  1: 10,
  2: 20,
  3: 40,
  4: 80,
  5: 1,
  6: 2,
  7: 4,
  8: 8,
  9: 16,
  10: 32,
};

/** Each period of `unit` with its total, as the calendar reads the instants. */
const totalsBy = (unit: BusinessUnit): [string, string][] => {
  const totals = new Map<string, number>();
  for (const [id, { at }] of Object.entries(ZONED_EVENTS)) {
    const period = periodStart(
      ZONED_CALENDAR,
      unit,
      localDate(new Date(at), ZONED_CALENDAR.timeZone)
    );
    totals.set(period, (totals.get(period) ?? 0) + AMOUNTS[Number(id)]!);
  }
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([p, t]) => [p, t.toFixed(2)]);
};

describeEachEngine("runQuery: grouping in the calendar's zone", (engine) => {
  const user = newQueryUser();
  const caller: Caller = {
    userId: user.id,
    organizationId: null,
    permissions: [DATA_READ],
    isServiceAccount: false,
  };
  const author = randomUUID();
  let source: SeededSource;

  const body = (query: object) => ({ source: source.slug, ...query });
  const run = async (query: object) =>
    runQuery({ caller, entryPoint: "api", body: body(query) });

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(
      engine,
      { schemas: [...engine.schemas, "probe"] },
      "zoned"
    );
    await grantTo(user.principal, source.tables.zoned_events!, "all");
    // The same sum dated by an aware and a naive timestamp, and by the date
    // each instant has in Los Angeles.
    for (const [name, dateColumn] of [
      ["at_amount", "at"],
      ["naive_amount", "naive"],
      ["day_amount", "day"],
    ]) {
      await prisma.measure.create({
        data: {
          sourceId: source.id,
          tableId: source.tables.zoned_events!.id,
          name: name!,
          description: `Amount by ${dateColumn}`,
          formula: { sum: "amount" },
          fixed: false,
          dateColumn: dateColumn!,
          createdBy: author,
          updatedBy: author,
        },
      });
    }
    const res = await fetchJson(
      "PUT",
      `${BASE_URL}/v1/calendar`,
      calendarWriteToken(),
      {
        working_days: [1, 2, 3, 4, 5],
        holidays: [],
        fiscal_year_start_month: ZONED_CALENDAR.fiscalYearStartMonth,
        time_zone: ZONED_CALENDAR.timeZone,
      }
    );
    if (res.status !== 200) throw new Error(`calendar not set: ${res.status}`);
    clearCalendarCache();
  });
  afterAll(async () => {
    await resetCalendar();
    await clearDashboardKeys();
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("puts instants before Monday's local midnight in the previous week: a range ending that Monday has no stray week", async () => {
    // Orders 1 and 2 are early on Monday 2026-07-13 in UTC, still Sunday in
    // Los Angeles: in the range, and in the week of 2026-07-06.
    const result = await run({
      metrics: ["at_amount", "naive_amount", "day_amount"],
      bucket: "week",
      range: { gte: { date: "2026-07-06" }, lt: { date: "2026-07-13" } },
    });
    expect(result.rows).toEqual([["2026-07-06", "110.00", "110.00", "110.00"]]);
    expect(result.columns[0]).toEqual({ name: "period", type: "date" });
  });

  it("lines up timestamp and date measures by local period at every unit", async () => {
    for (const unit of [
      "day",
      "week",
      "month",
      "quarter",
      "year",
      "fiscal_quarter",
      "fiscal_year",
    ] as const) {
      const result = await run({
        metrics: ["at_amount", "naive_amount", "day_amount"],
        bucket: unit,
      });
      expect(result.rows, unit).toEqual(
        totalsBy(unit).map(([period, total]) => [period, total, total, total])
      );
    }
  });

  it("divides by the business days of each local period", async () => {
    const metricId = randomUUID();
    await prisma.metric.create({
      data: {
        id: metricId,
        sourceId: source.id,
        name: "per_day",
        description: "Amount per business day",
        formula: {
          div: [{ measure: "at_amount" }, { businessDaysInPeriod: true }],
        },
        createdBy: author,
        updatedBy: author,
      },
    });
    try {
      const result = await run({
        metrics: ["per_day", "at_amount"],
        bucket: "month",
      });
      for (const [period, perDay, total] of result.rows) {
        const days = businessDaysIn(ZONED_CALENDAR, "month", period as string)!;
        expect(perDay, period as string).toBe(
          (Math.round((Number(total) / days) * 1e6) / 1e6).toFixed(6)
        );
      }
      expect(result.rows.map((r) => r[0])).toEqual(
        totalsBy("month").map(([p]) => p)
      );
    } finally {
      await prisma.metric.delete({ where: { id: metricId } });
    }
  });

  it("agrees with a dashboard's time range: last week, bucketed by week, is one week", async () => {
    const metricQuery = body({ metrics: ["at_amount"], bucket: "week" });
    const tableQuery = body({
      from: "zoned_events",
      select: [
        { bucket: "week", column: "at", as: "week" },
        { sum: "amount", as: "total" },
      ],
      groupBy: ["week"],
    });
    const dashboard = await prisma.dashboard.create({
      data: { ownerId: user.id, name: uniqueName("dashboard") },
    });
    // Wednesday 2026-07-15 in Los Angeles: the previous week is 07-06 to 07-12.
    const now = new Date("2026-07-15T19:00:00Z");
    try {
      await clearDashboardKeys();
      for (const [query, column] of [
        [metricQuery, "range"],
        [tableQuery, "at"],
      ] as const) {
        const saved = await prisma.savedQuery.create({
          data: {
            ownerId: user.id,
            sourceId: source.id,
            name: uniqueName(),
            query,
          },
        });
        const result = await runQuery({
          caller,
          entryPoint: "dashboard",
          body: withTimeFilter(query, column, "previous_week"),
          savedQuery: { id: saved.id, sourceId: source.id },
          dashboard: { dashboardId: dashboard.id, now },
        });
        expect(result.rows, column).toEqual([["2026-07-06", "110.00"]]);
      }
    } finally {
      await clearDashboardKeys();
    }
  });
});
