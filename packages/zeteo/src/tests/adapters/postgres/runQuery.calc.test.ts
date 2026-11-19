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
});
