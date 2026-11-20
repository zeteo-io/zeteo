import type { QueryResult } from "../../adapters/types.js";
import { describe, expect, it } from "vitest";
import {
  businessDayOfMonth,
  DEFAULT_CALENDAR,
  fiscalQuarterOf,
  fiscalYearOf,
  localDate,
  periodStart,
  type BusinessUnit,
  type Calendar,
} from "../../calendar/calendar.js";

// Buckets and date parts of a timestamp read its date in the calendar's zone,
// compared with the calendar's own functions over `probe.zoned_events`: the
// same suite runs on Postgres and on SQL Server, so both engines give the
// oracle's values.

/** `probe.zoned_events` by id: each instant and its date in Los Angeles. */
export const ZONED_EVENTS: Record<number, { at: string; day: string }> = {
  1: { at: "2026-07-13T03:00:00Z", day: "2026-07-12" },
  2: { at: "2026-07-13T06:59:59Z", day: "2026-07-12" },
  3: { at: "2026-07-13T07:00:00Z", day: "2026-07-13" },
  4: { at: "2026-07-10T12:00:00Z", day: "2026-07-10" },
  5: { at: "2026-08-01T05:00:00Z", day: "2026-07-31" },
  // Monday 00:30 after DST began (-07:00); at -08:00 it would be Sunday.
  6: { at: "2026-03-09T07:30:00Z", day: "2026-03-09" },
  // Saturday 23:30, before DST began on the Sunday.
  7: { at: "2026-03-08T07:30:00Z", day: "2026-03-07" },
  // Sunday 23:30 after DST ended (-08:00); at -07:00 it would be Monday.
  8: { at: "2026-11-02T07:30:00Z", day: "2026-11-01" },
  9: { at: "2026-04-01T03:00:00Z", day: "2026-03-31" },
  10: { at: "2026-01-01T07:59:59Z", day: "2025-12-31" },
};

const IDS = Object.keys(ZONED_EVENTS).map(Number);

/** Los Angeles, with a fiscal year from February: its quarters are not the calendar's. */
export const ZONED_CALENDAR: Calendar = {
  ...DEFAULT_CALENDAR,
  fiscalYearStartMonth: 2,
  timeZone: "America/Los_Angeles",
};

const UNITS: BusinessUnit[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_quarter",
  "fiscal_year",
];

const PARTS = [
  "year",
  "quarter",
  "month",
  "day",
  "weekday",
  "fiscal_year",
  "fiscal_quarter",
  "business_day",
] as const;

/** ISO weekday of a date, Monday 1. */
const weekdayOf = (date: string): number => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

/** A date part as the calendar computes it. */
const partOf = (
  cal: Calendar,
  part: (typeof PARTS)[number],
  date: string
): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  switch (part) {
    case "year":
      return y;
    case "quarter":
      return Math.floor((m - 1) / 3) + 1;
    case "month":
      return m;
    case "day":
      return d;
    case "weekday":
      return weekdayOf(date);
    case "fiscal_year":
      return fiscalYearOf(cal, date);
    case "fiscal_quarter":
      return fiscalQuarterOf(cal, date);
    case "business_day":
      return businessDayOfMonth(cal, date)!;
  }
};

type Run = (calendar: Calendar, query: object) => Promise<QueryResult>;

/** Registers the suite for one engine; `run` plans under `calendar` and runs on that engine. */
export const describeZonedGrouping = (engine: string, run: Run): void => {
  /** Each event's date as `cal` reads its instant. */
  const dateIn = (cal: Calendar, id: number) =>
    localDate(new Date(ZONED_EVENTS[id]!.at), cal.timeZone);

  describe(`${engine} runQuery: buckets and date parts in the calendar's zone`, () => {
    for (const cal of [
      ZONED_CALENDAR,
      { ...ZONED_CALENDAR, timeZone: "UTC" },
    ]) {
      it(`buckets an aware and a naive timestamp by the date in ${cal.timeZone}, at every unit, as a date`, async () => {
        const result = await run(cal, {
          from: "zoned_events",
          select: [
            "id",
            ...UNITS.flatMap((unit) =>
              ["at", "naive", "day"].map((column) => ({
                bucket: unit,
                column,
                as: `${unit}_${column}`,
              }))
            ),
          ],
          orderBy: [{ id: "asc" }],
        });
        expect(result.columns.slice(1).map((c) => c.type)).toEqual(
          UNITS.flatMap(() => ["date", "date", "date"])
        );
        expect(result.rows).toEqual(
          IDS.map((id) => [
            id,
            ...UNITS.flatMap((unit) => {
              const local = periodStart(cal, unit, dateIn(cal, id));
              // A date column is bucketed as it is, whatever the zone.
              const day = periodStart(cal, unit, ZONED_EVENTS[id]!.day);
              return [local, local, day];
            }),
          ])
        );
      });

      it(`reads every date part of a timestamp in ${cal.timeZone}`, async () => {
        const result = await run(cal, {
          from: "zoned_events",
          select: [
            "id",
            ...PARTS.map((part) => ({
              calc: { datePart: [part, "at"] },
              as: part,
            })),
          ],
          orderBy: [{ id: "asc" }],
        });
        expect(result.rows.map((r) => r.map(Number))).toEqual(
          IDS.map((id) => [
            id,
            ...PARTS.map((part) => partOf(cal, part, dateIn(cal, id))),
          ])
        );
      });
    }

    it("reads the local day across midnight, and the local week across a DST change", async () => {
      const result = await run(ZONED_CALENDAR, {
        from: "zoned_events",
        select: [
          "id",
          { bucket: "day", column: "at", as: "d" },
          { bucket: "week", column: "at", as: "w" },
          { calc: { datePart: ["day", "at"] }, as: "dd" },
          { calc: { datePart: ["weekday", "at"] }, as: "wd" },
        ],
        where: { id: { in: [1, 3, 6, 7, 8] } },
        orderBy: [{ id: "asc" }],
      });
      expect(result.rows.map((r) => r.map(String))).toEqual([
        // Monday 03:00 UTC is Sunday evening: the previous week.
        ["1", "2026-07-12", "2026-07-06", "12", "7"],
        ["3", "2026-07-13", "2026-07-13", "13", "1"],
        ["6", "2026-03-09", "2026-03-09", "9", "1"],
        ["7", "2026-03-07", "2026-03-02", "7", "6"],
        ["8", "2026-11-01", "2026-10-26", "1", "7"],
      ]);
    });

    it("groups by a local week, filtered and ordered by it", async () => {
      const result = await run(ZONED_CALENDAR, {
        from: "zoned_events",
        select: [
          { bucket: "week", column: "naive", as: "week" },
          { sum: "amount", as: "total" },
          { count: "*", as: "n" },
        ],
        groupBy: ["week"],
        having: { n: { gte: 1 } },
        orderBy: [{ week: "desc" }],
      });
      const totals = new Map<string, number>();
      for (const id of IDS) {
        const week = periodStart(
          ZONED_CALENDAR,
          "week",
          dateIn(ZONED_CALENDAR, id)
        );
        totals.set(week, (totals.get(week) ?? 0) + amountOf(id));
      }
      expect(result.rows.map(([week, total]) => [week, Number(total)])).toEqual(
        [...totals].sort(([a], [b]) => (a < b ? 1 : -1)).map(([w, t]) => [w, t])
      );
    });
  });
};

/** `probe.zoned_events.amount`: 10, 20, 40, 80, then 1, 2, 4, … 32. */
const amountOf = (id: number): number =>
  id <= 4 ? [10, 20, 40, 80][id - 1]! : 2 ** (id - 5);
