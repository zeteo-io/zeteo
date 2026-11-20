import type { QueryResult } from "../../adapters/types.js";
import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  businessDayOfMonth,
  businessDays,
  businessDaysBetween,
  businessDaysElapsed,
  businessDaysIn,
  businessDaysRemaining,
  isBusinessDay,
  localDate,
  type BusinessUnit,
  type Calendar,
} from "../../calendar/calendar.js";

// The business-day functions on one engine, compared with the calendar's own
// functions (the oracle the planner folds constants with): the same suite runs
// on Postgres and on SQL Server, so both engines give the oracle's values.

/** Mondays to Thursdays and Saturdays, so neither weekend nor week is the usual one. */
export const ODD_CALENDAR: Calendar = {
  workingDays: [1, 2, 3, 4, 6],
  holidays: new Map([
    ["1900-01-02", "next to the anchor"],
    ["2026-01-03", "a Saturday, the working week's last day"],
    ["2026-01-05", "a Monday, the week's first"],
    ["2026-03-08", "a Sunday: not a working day"],
    ["2026-03-13", "a Friday: not a working day"],
    ["2026-12-28", "Monday, then"],
    ["2026-12-29", "Tuesday, adjacent"],
    ["2026-12-31", "a Thursday"],
    ["2027-01-02", "a Saturday after the new year"],
  ]),
  fiscalYearStartMonth: 4,
  timeZone: "America/Los_Angeles",
};

/** The fixture's orders by id, as stored (the same on both engines). */
export const ORDER_TIMES: Record<number, string> = {
  1: "2026-01-05T09:00:00Z",
  2: "2026-01-20T14:30:00Z",
  3: "2026-02-02T08:15:00Z",
  4: "2026-02-14T18:45:30Z",
  5: "2026-03-01T00:00:00Z",
  6: "2026-03-31T23:59:59.999Z",
  7: "2026-04-01T00:00:00Z",
  8: "2026-04-18T11:11:11Z",
  9: "2026-05-05T05:05:05Z",
  10: "2026-05-25T16:00:00Z",
  11: "2026-06-10T10:10:10.5Z",
  12: "2026-06-30T12:00:00Z",
};

/** A small deterministic generator, so a failure names the same dates every run. */
const generator = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Dates around the anchor, holidays, week, month and year ends, and random ones. */
export const sampleDates = (count: number, seed = 7): string[] => {
  const random = generator(seed);
  const fixed = [
    "1899-12-31",
    "1900-01-01",
    "1900-01-02",
    "1900-01-03",
    "1900-01-07",
    "2026-01-01",
    "2026-01-03",
    "2026-01-04",
    "2026-01-05",
    "2026-03-08",
    "2026-03-14",
    "2026-12-27",
    "2026-12-28",
    "2026-12-30",
    "2026-12-31",
    "2027-01-02",
    "2027-03-31",
  ];
  const from = Date.UTC(1899, 11, 1);
  const span = Date.UTC(2031, 0, 1) - from;
  const generated = Array.from({ length: count - fixed.length }, () =>
    iso(from + Math.floor(random() * (span / DAY)) * DAY)
  );
  return [...fixed, ...generated];
};

/** A date that compiles rather than folds: an operation over the literal. */
export const asDate = (date: string) => ({
  dateAdd: [{ date }, 0, "day"],
});
export const asTimestamp = (timestamp: string) => ({
  dateAdd: [{ timestamp }, 0, "day"],
});

type Run = (calendar: Calendar, query: object) => Promise<QueryResult>;

/**
 * Each expression's value, computed by the engine inside an aggregate over
 * the fixture's orders (every row gives the same value), 20 to a query.
 */
const valuesOf = async (
  run: Run,
  calendar: Calendar,
  exprs: unknown[]
): Promise<unknown[]> => {
  const out: unknown[] = [];
  for (let i = 0; i < exprs.length; i += 20) {
    const chunk = exprs.slice(i, i + 20);
    const result = await run(calendar, {
      from: "orders",
      select: chunk.map((e, j) => ({ max: e, as: `x${j}` })),
    });
    out.push(...(result.rows[0] as unknown[]));
  }
  return out;
};

const PERIODS: Exclude<BusinessUnit, "day">[] = [
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_quarter",
  "fiscal_year",
];

/** Registers the suite for one engine; `run` plans under `calendar` and runs on that engine. */
export const describeBusinessDays = (engine: string, run: Run): void => {
  const cal = ODD_CALENDAR;
  const tz = cal.timeZone;
  const dates = sampleDates(40);

  describe(`${engine} runQuery: business days, compared with the calendar`, () => {
    it("counts businessDays and businessDaysBetween over date pairs", async () => {
      const pairs = dates.map(
        (a, i) => [a, dates[(i * 7 + 3) % dates.length]!] as const
      );
      pairs.push(["2026-01-05", "2026-01-06"], ["2026-01-09", "2026-01-12"]);
      const exprs = pairs.flatMap(([a, b]) => [
        { businessDays: [asDate(a), asDate(b)] },
        { businessDaysBetween: [asDate(a), asDate(b)] },
      ]);
      const expected = pairs.flatMap(([a, b]) => [
        businessDays(cal, a, b),
        businessDaysBetween(cal, a, b),
      ]);
      expect(await valuesOf(run, cal, exprs)).toEqual(expected);
    });

    it("counts the business days in, through and after a date's period for every unit", async () => {
      // Fiscal years start in April; a period starting before 1900 is null.
      const some = dates.filter((_, i) => i % 2 === 0);
      for (const unit of PERIODS) {
        const exprs = some.flatMap((d) => [
          { businessDaysIn: [unit, asDate(d)] },
          { businessDaysElapsed: [unit, asDate(d)] },
          { businessDaysRemaining: [unit, asDate(d)] },
        ]);
        const expected = some.flatMap((d) => [
          businessDaysIn(cal, unit, d),
          businessDaysElapsed(cal, d, unit),
          businessDaysRemaining(cal, d, unit),
        ]);
        expect(await valuesOf(run, cal, exprs), unit).toEqual(expected);
      }
    });

    it("reads a month without a unit, and the business_day part as the month's elapsed business days", async () => {
      const exprs = dates.flatMap((d) => [
        { businessDaysInMonth: asDate(d) },
        { businessDaysElapsed: asDate(d) },
        { businessDaysRemaining: asDate(d) },
        { datePart: ["business_day", asDate(d)] },
      ]);
      const expected = dates.flatMap((d) => [
        businessDaysIn(cal, "month", d),
        businessDaysElapsed(cal, d),
        businessDaysRemaining(cal, d),
        businessDayOfMonth(cal, d),
      ]);
      expect(await valuesOf(run, cal, exprs)).toEqual(expected);
    });

    it("adds business days forward, back and zero, across holidays and weekends", async () => {
      const steps = [0, 1, -1, 2, -2, 5, -5, 13, -13, 2.7, -2.7];
      const starts = [
        ...dates.slice(0, 20),
        "2026-12-25",
        "2026-12-26",
        "2026-12-27",
        "2026-03-13",
      ];
      const cases = starts.flatMap((d, i) =>
        [steps[i % steps.length]!, steps[(i + 4) % steps.length]!].map(
          (n) => [d, n] as const
        )
      );
      const exprs = cases.map(([d, n]) => ({
        addBusinessDays: [asDate(d), n],
      }));
      const expected = cases.map(([d, n]) => addBusinessDays(cal, d, n));
      expect(await valuesOf(run, cal, exprs)).toEqual(expected);
    });

    it("gives null past the last date, before the anchor and for a step too large", async () => {
      const exprs = [
        { addBusinessDays: [asDate("9999-12-30"), 5] },
        { addBusinessDays: [asDate("1900-01-03"), -5] },
        { addBusinessDays: [asDate("2026-01-01"), 3_000_001] },
        { addBusinessDays: [asDate("2026-01-01"), -1e300] },
        { businessDays: [asDate("1899-12-31"), asDate("2026-01-01")] },
        { businessDaysIn: ["fiscal_year", asDate("1900-02-01")] },
        { businessDays: [asDate("1900-01-01"), asDate("9999-12-31")] },
      ];
      expect(await valuesOf(run, cal, exprs)).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
        businessDays(cal, "1900-01-01", "9999-12-31"),
      ]);
    });

    it("gives null outside 1900-01-01 to 9998-12-31, never an error, for every function and a fiscal year from July", async () => {
      const july = { ...cal, fiscalYearStartMonth: 7 };
      const edges = [
        "0001-01-01",
        "0001-03-01",
        "1899-12-31",
        "1900-01-01",
        "9998-12-31",
        "9999-12-31",
      ];
      // A literal before year 1000 is refused, so those are reached by dateAdd.
      const at = (d: string) =>
        d < "1000"
          ? {
              dateAdd: [
                { date: `${Number(d.slice(0, 4)) + 1900}${d.slice(4)}` },
                -1900,
                "year",
              ],
            }
          : asDate(d);
      const exprs = edges.flatMap((d) => [
        { businessDays: [at(d), at(d)] },
        { businessDaysBetween: [at(d), asDate("2026-01-01")] },
        { businessDaysBetween: [asDate("2026-01-01"), at(d)] },
        ...PERIODS.flatMap((unit) => [
          { businessDaysIn: [unit, at(d)] },
          { businessDaysElapsed: [unit, at(d)] },
          { businessDaysRemaining: [unit, at(d)] },
        ]),
        { datePart: ["business_day", at(d)] },
        { addBusinessDays: [at(d), 1] },
        { addBusinessDays: [at(d), -1] },
        { addBusinessDays: [at(d), 0] },
      ]);
      const expected = edges.flatMap((d) => [
        businessDays(july, d, d),
        businessDaysBetween(july, d, "2026-01-01"),
        businessDaysBetween(july, "2026-01-01", d),
        ...PERIODS.flatMap((unit) => [
          businessDaysIn(july, unit, d),
          businessDaysElapsed(july, d, unit),
          businessDaysRemaining(july, d, unit),
        ]),
        businessDayOfMonth(july, d),
        addBusinessDays(july, d, 1),
        addBusinessDays(july, d, -1),
        addBusinessDays(july, d, 0),
      ]);
      const perEdge = expected.length / edges.length;
      const of = (d: string) =>
        expected.slice(
          edges.indexOf(d) * perEdge,
          (edges.indexOf(d) + 1) * perEdge
        );
      for (const outside of [
        "0001-01-01",
        "0001-03-01",
        "1899-12-31",
        "9999-12-31",
      ]) {
        expect(
          of(outside).every((v) => v === null),
          outside
        ).toBe(true);
      }
      expect(of("9998-12-31").filter((v) => v !== null).length).toBeGreaterThan(
        20
      );
      expect(businessDaysIn(july, "fiscal_year", "9998-12-31")).toBeGreaterThan(
        0
      );
      expect(await valuesOf(run, july, exprs)).toEqual(expected);
    });

    it("reads a zone Postgres also knows as an abbreviation by its rules: CET in summer", async () => {
      const cet = { ...cal, timeZone: "CET" };
      const stamps = [
        "2026-07-01T21:59:59Z",
        "2026-07-01T22:00:00Z",
        "2026-07-01T22:30:00Z",
        "2026-07-01T22:59:59Z",
        "2026-07-01T23:00:00Z",
      ];
      const local = (t: string) => localDate(new Date(t), "CET");
      expect(stamps.map(local)).toEqual([
        "2026-07-01",
        "2026-07-02",
        "2026-07-02",
        "2026-07-02",
        "2026-07-02",
      ]);
      const exprs = stamps.flatMap((t) => [
        { businessDaysElapsed: asTimestamp(t) },
        { addBusinessDays: [asTimestamp(t), 0] },
      ]);
      const expected = stamps.flatMap((t) => [
        businessDaysElapsed(cet, local(t)),
        addBusinessDays(cet, local(t), 0),
      ]);
      expect(await valuesOf(run, cet, exprs)).toEqual(expected);
    });

    it("reads a timestamp as its date in the calendar's zone, across midnight and the change to summer time", async () => {
      // Los Angeles moves to summer time at 10:00 UTC on 8 March 2026.
      const stamps = [
        "2026-03-07T07:59:59Z",
        "2026-03-07T08:00:00Z",
        "2026-03-08T07:59:59Z",
        "2026-03-08T08:00:00Z",
        "2026-03-08T09:59:59Z",
        "2026-03-08T10:00:00Z",
        "2026-03-09T06:59:59Z",
        "2026-03-09T07:00:00Z",
        "2026-11-01T08:59:59Z",
        "2026-11-01T09:00:00Z",
        "2026-12-31T23:30:00Z",
        "2027-01-01T08:30:00Z",
      ];
      const local = (t: string) => localDate(new Date(t), tz);
      const exprs = stamps.flatMap((t, i) => {
        const other = stamps[(i + 5) % stamps.length]!;
        return [
          { businessDays: [asTimestamp(t), asTimestamp(other)] },
          { businessDaysBetween: [asTimestamp(t), asDate("2026-03-20")] },
          { businessDaysIn: ["week", asTimestamp(t)] },
          { businessDaysElapsed: asTimestamp(t) },
          { addBusinessDays: [asTimestamp(t), 1] },
        ];
      });
      const expected = stamps.flatMap((t, i) => {
        const other = stamps[(i + 5) % stamps.length]!;
        return [
          businessDays(cal, local(t), local(other)),
          businessDaysBetween(cal, local(t), "2026-03-20"),
          businessDaysIn(cal, "week", local(t)),
          businessDaysElapsed(cal, local(t)),
          addBusinessDays(cal, local(t), 1),
        ];
      });
      expect(await valuesOf(run, cal, exprs)).toEqual(expected);
    });

    it("gives null for a timestamp outside the zone's window, and reads UTC without one", async () => {
      const utc = { ...cal, timeZone: "UTC" };
      expect(
        await valuesOf(run, cal, [
          { businessDaysElapsed: asTimestamp("1990-06-15T12:00:00Z") },
          { businessDaysElapsed: asTimestamp("2026-06-15T03:00:00Z") },
        ])
      ).toEqual([null, businessDaysElapsed(cal, "2026-06-14")]);
      expect(
        await valuesOf(run, utc, [
          { businessDaysElapsed: asTimestamp("1990-06-15T12:00:00Z") },
          { businessDaysElapsed: asTimestamp("2026-06-15T03:00:00Z") },
        ])
      ).toEqual([
        businessDaysElapsed(utc, "1990-06-15"),
        businessDaysElapsed(utc, "2026-06-15"),
      ]);
    });

    it("computes per row over a timestamp column, grouped and ordered by the result", async () => {
      const result = await run(cal, {
        from: "orders",
        select: [
          "id",
          {
            calc: {
              businessDaysBetween: [
                "created_at",
                { dateAdd: ["created_at", 10, "day"] },
              ],
            },
            as: "ten_days",
          },
          { calc: { addBusinessDays: ["created_at", "id"] }, as: "due" },
          { calc: { businessDaysIn: ["month", "created_at"] }, as: "month" },
        ],
        orderBy: [{ id: "asc" }],
      });
      const local = (id: number) => localDate(new Date(ORDER_TIMES[id]!), tz);
      const plus = (date: string, days: number) =>
        iso(Date.parse(`${date}T00:00:00Z`) + days * DAY);
      expect(result.rows).toEqual(
        Object.keys(ORDER_TIMES).map((key) => {
          const id = Number(key);
          return [
            id,
            businessDaysBetween(cal, local(id), plus(local(id), 10)),
            addBusinessDays(cal, local(id), id),
            businessDaysIn(cal, "month", local(id)),
          ];
        })
      );

      const grouped = await run(cal, {
        from: "orders",
        select: [
          { calc: { businessDaysIn: ["month", "created_at"] }, as: "days" },
          { count: "*", as: "n" },
        ],
        groupBy: ["days"],
        orderBy: [{ days: "desc" }],
      });
      const counts = new Map<number, number>();
      for (const id of Object.keys(ORDER_TIMES).map(Number)) {
        const days = businessDaysIn(cal, "month", local(id))!;
        counts.set(days, (counts.get(days) ?? 0) + 1);
      }
      expect(grouped.rows.map(([days, n]) => [days, Number(n)])).toEqual(
        [...counts].sort((a, b) => b[0] - a[0]).map(([d, n]) => [d, n])
      );
    });

    it("computes over aggregates, per group, and orders by the result", async () => {
      const local = (id: number) => localDate(new Date(ORDER_TIMES[id]!), tz);
      const result = await run(cal, {
        from: "orders",
        select: [
          "customer_id",
          {
            calc: {
              businessDaysBetween: [
                { min: "created_at" },
                { max: "created_at" },
              ],
            },
            as: "span",
          },
        ],
        groupBy: ["customer_id"],
        orderBy: [{ span: "desc" }, { customer_id: "asc" }],
      });
      // Customers 1, 2 and 3 hold orders 1, 2, 7, 10; 3, 5, 8, 11; 4, 6, 9, 12.
      const span = (ids: number[]) =>
        businessDaysBetween(
          cal,
          local(Math.min(...ids)),
          local(Math.max(...ids))
        )!;
      const expected = [
        [1, span([1, 2, 7, 10])],
        [2, span([3, 5, 8, 11])],
        [3, span([4, 6, 9, 12])],
      ].sort((a, b) => b[1]! - a[1]! || a[0]! - b[0]!);
      expect(result.rows).toEqual(expected);
    });

    it("filters rows on isBusinessDay, true and false, in where and in a case's if", async () => {
      const local = (id: number) => localDate(new Date(ORDER_TIMES[id]!), tz);
      const ids = Object.keys(ORDER_TIMES).map(Number);
      const business = ids.filter((id) => isBusinessDay(cal, local(id)));
      const idsWhere = async (is: boolean) =>
        (
          await run(cal, {
            from: "orders",
            select: ["id"],
            where: { created_at: { isBusinessDay: is } },
            orderBy: [{ id: "asc" }],
          })
        ).rows.map((r) => r[0]);
      expect(await idsWhere(true)).toEqual(business);
      expect(await idsWhere(false)).toEqual(
        ids.filter((id) => !business.includes(id))
      );
      const cased = await run(cal, {
        from: "orders",
        select: [
          {
            count: {
              case: {
                when: [
                  { if: { created_at: { isBusinessDay: true } }, then: 1 },
                ],
              },
            },
            as: "n",
          },
        ],
      });
      expect(Number(cased.rows[0]![0])).toBe(business.length);
    });

    it("counts with a calendar of Mondays to Fridays and no holidays as NETWORKDAYS does", async () => {
      const plain: Calendar = {
        workingDays: [1, 2, 3, 4, 5],
        holidays: new Map(),
        fiscalYearStartMonth: 1,
        timeZone: "UTC",
      };
      expect(
        await valuesOf(run, plain, [
          { businessDaysBetween: [asDate("2026-11-16"), asDate("2026-11-17")] },
          { businessDaysBetween: [asDate("2026-11-20"), asDate("2026-11-23")] },
          { businessDaysBetween: [asDate("2026-11-17"), asDate("2026-11-09")] },
          { businessDays: [asDate("2026-11-20"), asDate("2026-11-19")] },
          { addBusinessDays: [asDate("2026-11-21"), 0] },
          { addBusinessDays: [asDate("2026-11-21"), -1] },
        ])
      ).toEqual([1, 1, -6, 0, "2026-11-23", "2026-11-20"]);
    });
  });
};
