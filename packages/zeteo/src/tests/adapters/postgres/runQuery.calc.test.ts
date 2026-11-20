// @module-tag int
// @module-tag platform
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { usePostgresRuns } from "../../support/postgresRuns.js";
import { describe, expect, it } from "vitest";

const { run, runWithCalendar } = usePostgresRuns();

describe("postgres runQuery: calculations", () => {
  it("computes a case: conditional sums and counts equal their filtered queries, and text cases return text", async () => {
    const paid = { status: { eq: "paid" } };
    const conditional = await run({
      from: "orders",
      select: [
        {
          sum: { case: { when: [{ if: paid, then: "total" }] } },
          as: "paid",
        },
        {
          count: { case: { when: [{ if: paid, then: 1 }] } },
          as: "paid_orders",
        },
        {
          countDistinct: {
            case: { when: [{ if: paid, then: "customer_id" }] },
          },
          as: "paid_customers",
        },
      ],
    });
    const filtered = await run({
      from: "orders",
      select: [
        { sum: "total", as: "paid" },
        { count: "*", as: "paid_orders" },
        { countDistinct: "customer_id", as: "paid_customers" },
      ],
      where: paid,
    });
    expect(conditional.rows).toEqual(filtered.rows);
    expect(conditional.rows).toEqual([["3585.59", "7", "3"]]);

    const text = await run({
      from: "orders",
      select: [
        "id",
        {
          calc: {
            case: {
              when: [{ if: { total: { gte: 500 } }, then: { value: "big" } }],
              else: "status",
            },
          },
          as: "size",
        },
      ],
      where: { id: { in: [1, 4, 8] } },
    });
    expect(text.rows).toEqual([
      [1, "paid"],
      [4, "big"],
      [8, "big"],
    ]);
  });

  it.each([
    [
      2,
      [
        ["2025-02-01T00:00:00.000Z", "2"],
        ["2026-02-01T00:00:00.000Z", "10"],
      ],
    ],
    [1, [["2026-01-01T00:00:00.000Z", "12"]]],
  ])("buckets a fiscal year starting in month %s", async (month, expected) => {
    const result = await runWithCalendar(
      { ...DEFAULT_CALENDAR, fiscalYearStartMonth: month },
      {
        from: "orders",
        select: [
          { bucket: "fiscal_year", column: "created_at", as: "fy" },
          { count: "*", as: "n" },
        ],
        groupBy: ["fy"],
      }
    );
    expect(result.rows).toEqual(expected);
  });

  it("buckets a fiscal quarter from a start month that is not a calendar quarter's", async () => {
    const result = await runWithCalendar(
      { ...DEFAULT_CALENDAR, fiscalYearStartMonth: 2 },
      {
        from: "orders",
        select: [
          { bucket: "fiscal_quarter", column: "created_at", as: "fq" },
          { count: "*", as: "n" },
        ],
        groupBy: ["fq"],
      }
    );
    // Quarters start in February, May, August and November.
    expect(result.rows).toEqual([
      ["2025-11-01T00:00:00.000Z", "2"],
      ["2026-02-01T00:00:00.000Z", "6"],
      ["2026-05-01T00:00:00.000Z", "4"],
    ]);
  });

  it("sums a mixed-kind case like the same sum under where", async () => {
    const cased = await run({
      from: "orders",
      select: [
        {
          sum: {
            case: {
              when: [{ if: { status: { eq: "paid" } }, then: "total" }],
              else: 0,
            },
          },
          as: "x",
        },
      ],
    });
    const filtered = await run({
      from: "orders",
      select: [{ sum: "total", as: "x" }],
      where: { status: { eq: "paid" } },
    });
    expect(cased.rows).toEqual(filtered.rows);
    expect(cased.rows).toEqual([["3585.59"]]);
  });

  // A calculation reads a column, so the literal dates sit inside an aggregate.
  const over = (expr: unknown, calendar = DEFAULT_CALENDAR) =>
    runWithCalendar(calendar, {
      from: "orders",
      select: [{ max: expr, as: "x" }],
    }).then((r) => r.rows[0]![0]);
  const day = (d: string) => ({ date: d });

  it("counts whole units completed between two dates, the same on both engines", async () => {
    const diff = (unit: string, a: string, b: string) =>
      over({ dateDiff: [unit, day(a), day(b)] });
    expect(await diff("month", "2026-01-31", "2026-03-01")).toBe(1);
    expect(await diff("day", "2026-01-31", "2026-03-01")).toBe(29);
    expect(await diff("month", "2026-01-31", "2026-02-28")).toBe(1);
    expect(await diff("month", "2026-03-31", "2026-02-28")).toBe(-1);
    expect(await diff("month", "2026-03-01", "2026-01-31")).toBe(-1);
    expect(await diff("week", "2026-01-01", "2026-01-14")).toBe(1);
    expect(await diff("week", "2026-01-14", "2026-01-01")).toBe(-1);
    expect(await diff("quarter", "2026-01-31", "2026-07-30")).toBe(1);
    expect(await diff("year", "2024-02-29", "2025-02-28")).toBe(1);
    expect(await diff("year", "2024-02-29", "2025-02-27")).toBe(0);
  });

  it("counts whole days between timestamps, not the days they touch", async () => {
    const stamp = (t: string) => ({ timestamp: t });
    expect(
      await over({
        dateDiff: [
          "day",
          stamp("2026-01-01T12:00:00Z"),
          stamp("2026-01-02T11:59:59Z"),
        ],
      })
    ).toBe(0);
    expect(
      await over({
        dateDiff: [
          "day",
          stamp("2026-01-02T12:00:00Z"),
          stamp("2026-01-01T12:00:01Z"),
        ],
      })
    ).toBe(0);
    expect(
      await over({
        dateDiff: [
          "day",
          stamp("2026-01-03T12:00:00Z"),
          stamp("2026-01-01T12:00:00Z"),
        ],
      })
    ).toBe(-2);
  });

  it("counts whole hours, minutes and seconds, truncated toward zero, the same on both engines", async () => {
    const stamp = (t: string) => ({ timestamp: t });
    const diff = (unit: string, a: unknown, b: unknown) =>
      over({ dateDiff: [unit, a, b] });
    const start = stamp("2026-09-11T08:26:20Z");
    const end = stamp("2026-09-11T08:28:12.900Z");
    expect(await diff("second", start, end)).toBe("112");
    expect(await diff("minute", start, end)).toBe("1");
    expect(await diff("hour", start, end)).toBe("0");
    expect(await diff("second", end, start)).toBe("-112");
    expect(
      await diff(
        "hour",
        stamp("2026-01-01T00:00:00Z"),
        stamp("2026-01-03T05:59:59Z")
      )
    ).toBe("53");
    // Dates count from midnight: whole days of them.
    expect(await diff("minute", day("2026-01-01"), day("2026-01-02"))).toBe(
      "1440"
    );
  });

  it("adds to a date and clamps at the end of a month", async () => {
    expect(await over({ dateAdd: [day("2026-01-31"), 1, "month"] })).toBe(
      "2026-02-28"
    );
    expect(await over({ dateAdd: [day("2024-02-29"), 1, "year"] })).toBe(
      "2025-02-28"
    );
    expect(await over({ dateAdd: [day("2026-01-31"), -1, "quarter"] })).toBe(
      "2025-10-31"
    );
    expect(await over({ dateAdd: [day("2026-01-31"), 2, "week"] })).toBe(
      "2026-02-14"
    );
  });

  it("adds to a timestamp column and keeps its type", async () => {
    const result = await runWithCalendar(DEFAULT_CALENDAR, {
      from: "orders",
      select: [
        { calc: { dateAdd: ["created_at", 1, "day"] }, as: "next" },
        "created_at",
      ],
      orderBy: [{ created_at: "asc" }],
      limit: 1,
    });
    const [next, created] = result.rows[0] as [string, string];
    expect(Date.parse(next) - Date.parse(created)).toBe(86_400_000);
  });

  it("reads the parts of a date, Monday as 1", async () => {
    const part = (p: string, d: string) => over({ datePart: [p, day(d)] });
    expect(await part("weekday", "2026-11-22")).toBe(7);
    expect(await part("weekday", "2026-11-16")).toBe(1);
    expect(await part("year", "2026-11-22")).toBe(2026);
    expect(await part("quarter", "2026-11-22")).toBe(4);
    expect(await part("month", "2026-11-22")).toBe(11);
    expect(await part("day", "2026-11-22")).toBe(22);
  });

  it("reads fiscal parts from the calendar, a fiscal year named by the year it ends in", async () => {
    const feb = { ...DEFAULT_CALENDAR, fiscalYearStartMonth: 2 };
    expect(
      await over({ datePart: ["fiscal_year", day("2026-02-01")] }, feb)
    ).toBe(2027);
    expect(
      await over({ datePart: ["fiscal_year", day("2026-01-31")] }, feb)
    ).toBe(2026);
    expect(
      await over({ datePart: ["fiscal_quarter", day("2026-01-31")] }, feb)
    ).toBe(4);
    expect(
      await over({ datePart: ["fiscal_quarter", day("2026-05-01")] }, feb)
    ).toBe(2);
    expect(await over({ datePart: ["fiscal_year", day("2026-12-31")] })).toBe(
      2026
    );
  });

  it("measures from a relative date in the calendar's time zone", async () => {
    const ahead = await over({
      dateDiff: [
        "day",
        { relative: { unit: "day", offset: 0 } },
        day("2999-01-01"),
      ],
    });
    expect(ahead).toBeGreaterThan(300_000);
  });

  it("takes dates in min, max, coalesce and case", async () => {
    expect(
      await over({
        coalesce: [
          {
            case: {
              when: [{ if: { id: { eq: -1 } }, then: day("2000-01-01") }],
            },
          },
          day("2026-05-05"),
        ],
      })
    ).toBe("2026-05-05");
    const result = await runWithCalendar(DEFAULT_CALENDAR, {
      from: "orders",
      select: [{ min: { dateAdd: ["created_at", 0, "day"] }, as: "first" }],
    });
    const plain = await runWithCalendar(DEFAULT_CALENDAR, {
      from: "orders",
      select: [{ min: "created_at", as: "first" }],
    });
    expect(result.rows).toEqual(plain.rows);
  });

  it("reads an offset timestamp as its UTC instant in every date operation", async () => {
    // probe/typed_values row 1: aware is 2026-03-31 23:59:59.98 at +02:00,
    // which is 21:59:59.98 UTC; read as wall time it would be two hours later.
    const aware = (calc: unknown) =>
      runWithCalendar(DEFAULT_CALENDAR, {
        from: "typed_values",
        select: [{ calc, as: "x" }],
        where: { id: { eq: 1 } },
      }).then((r) => r.rows[0]![0]);
    expect(
      await aware({
        dateDiff: ["day", "aware", { timestamp: "2026-04-01T22:00:00Z" }],
      })
    ).toBe(1);
    expect(
      await aware({
        dateDiff: ["day", { timestamp: "2026-03-31T22:00:00Z" }, "aware"],
      })
    ).toBe(0);
    expect(await aware({ datePart: ["day", "aware"] })).toBe(31);
    expect(
      await aware({
        dateDiff: ["day", "aware", { dateAdd: ["aware", 1, "month"] }],
      })
    ).toBe(30);
    const shifted = (await aware({ dateAdd: ["aware", 1, "day"] })) as string;
    expect(shifted.slice(0, 19)).toBe("2026-04-01T21:59:59");
  });
});

describe("postgres runQuery: businessDaysInMonth over a column", () => {
  const holiday = {
    ...DEFAULT_CALENDAR,
    holidays: new Map([["2026-01-19", "Martin Luther King Jr. Day"]]),
  };

  it("divides each month's total by its business days, a holiday counted out", async () => {
    const result = await runWithCalendar(holiday, {
      from: "orders",
      select: [
        { bucket: "month", column: "created_at", as: "month" },
        { max: { businessDaysInMonth: "created_at" }, as: "days" },
        {
          calc: {
            div: [
              { sum: "total" },
              { max: { businessDaysInMonth: "created_at" } },
            ],
          },
          as: "per_day",
        },
      ],
      groupBy: ["month"],
      where: { created_at: { lt: "2026-04-01T00:00:00Z" } },
    });
    // January 2026 has 22 weekdays and the 19th is a holiday; February 20; March 22.
    expect(result.rows.map((r) => r[1])).toEqual([21, 20, 22]);
    const perDay = result.rows.map((r) => Number(r[2]));
    expect(perDay[0]).toBeCloseTo(260.5 / 21, 5);
    expect(perDay[1]).toBeCloseTo(1299.99 / 20, 5);
    expect(perDay[2]).toBeCloseTo(80.25 / 22, 5);
  });

  it("reads a date column and a date operation by their months", async () => {
    const days = (arg: unknown) =>
      runWithCalendar(holiday, {
        from: "typed_values",
        select: [{ calc: { businessDaysInMonth: arg }, as: "x" }],
        where: { id: { eq: 5 } },
      }).then((r) => r.rows[0]![0]);
    expect(await days("day")).toBe(21);
    expect(await days({ dateAdd: ["day", 1, "month"] })).toBe(20);
  });

  it("gives null for a month outside the 25-year window", async () => {
    const result = await runWithCalendar(DEFAULT_CALENDAR, {
      from: "typed_values",
      select: [
        {
          calc: { businessDaysInMonth: { dateAdd: ["day", 30, "year"] } },
          as: "x",
        },
      ],
      where: { id: { eq: 5 } },
    });
    expect(result.rows).toEqual([[null]]);
  });

  it("filters and orders by the month's business days", async () => {
    const result = await runWithCalendar(holiday, {
      from: "orders",
      select: [
        "id",
        { calc: { businessDaysInMonth: "created_at" }, as: "days" },
      ],
      where: {
        and: [
          { created_at: { lt: "2026-04-01T00:00:00Z" } },
          { id: { in: [1, 3, 5] } },
        ],
      },
      orderBy: [{ days: "asc" }, { id: "asc" }],
    });
    expect(result.rows).toEqual([
      [3, 20],
      [1, 21],
      [5, 22],
    ]);
  });

  it("reads an offset timestamp as its UTC month", async () => {
    // typed_values row 3: aware is 1999-12-31 23:00 at -05:00, which is
    // 2000-01-01 04:00 UTC; 26 years on it is January 2026 in UTC (22 weekdays
    // less the holiday), and December 2025 (23) read as wall time.
    const result = await runWithCalendar(holiday, {
      from: "typed_values",
      select: [
        {
          calc: { businessDaysInMonth: { dateAdd: ["aware", 26, "year"] } },
          as: "x",
        },
      ],
      where: { id: { eq: 3 } },
    });
    expect(result.rows).toEqual([[21]]);
  });
});
