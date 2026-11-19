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
