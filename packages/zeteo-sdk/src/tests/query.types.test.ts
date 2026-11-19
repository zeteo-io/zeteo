import type { CalcExpr, Query, SelectItem } from "../types/query.js";
import type { ChartSettings } from "../types/dashboards.js";
import { describe, expect, it } from "vitest";

describe("query types", () => {
  it("accept calculations, nested and in aggregates", () => {
    const lineTotal: SelectItem = {
      calc: { mul: ["unitprice", "orderqty"] },
      as: "linetotal",
    };
    const margin: CalcExpr = {
      mul: [100, { div: [{ sum: "profit" }, { sum: "linetotal" }] }],
    };
    const revenue: SelectItem = {
      sum: { mul: ["unitprice", "orderqty"] },
      as: "revenue",
    };
    const rounded: SelectItem = {
      calc: { round: [margin, 2] },
      as: "margin_pct",
    };
    const fullName: SelectItem = {
      calc: { concat: ["firstname", { value: " " }, "lastname"] },
      as: "fullname",
    };
    const plain: SelectItem = { sum: "total" };
    const query: Query = {
      source: "s",
      from: "orders",
      select: [lineTotal, revenue, rounded, fullName, plain],
    };
    expect(query.select).toHaveLength(5);
  });

  it("require an as on a calc and on an aggregate over an expression", () => {
    // @ts-expect-error a calc needs a name
    const calc: SelectItem = { calc: { abs: "balance" } };
    // @ts-expect-error a sum over an expression needs a name
    const sum: SelectItem = { sum: { mul: ["a", "b"] } };
    // @ts-expect-error an operation has operands, not a bare key
    const bad: CalcExpr = { frobnicate: ["a"] };
    expect([calc, sum, bad]).toHaveLength(3);
  });

  it("take a relative date wherever a comparison takes a value", () => {
    const query: Query = {
      source: "s",
      from: "orders",
      select: ["id"],
      where: {
        created_at: { gte: { relative: { unit: "day", offset: -30 } } },
        shipped_at: {
          between: [
            { relative: { unit: "month", offset: 0, startOf: true } },
            "2026-12-31",
          ],
        },
      },
    };
    expect(query.where).toBeDefined();
    const bad: Query = {
      source: "s",
      from: "t",
      select: ["id"],
      // @ts-expect-error a relative date has a unit and an offset
      where: { at: { lt: { relative: { unit: "fortnight", offset: 1 } } } },
    };
    expect(bad).toBeDefined();
  });

  it("accept measures, case, dates and the calendar functions", () => {
    const items: SelectItem[] = [
      { measure: "total_revenue" },
      { measure: "orders", as: "n" },
      { bucket: "fiscal_quarter", column: "created_at", as: "q" },
      {
        count: {
          case: {
            when: [{ if: { status: { eq: "open" } }, then: 1 }],
            else: 0,
          },
        },
        as: "open_orders",
      },
      {
        calc: {
          div: [
            { measure: "spend_mtd" },
            { businessDaysElapsed: { relative: { unit: "day", offset: 0 } } },
          ],
        },
        as: "daily_pace",
      },
      {
        calc: {
          datePart: [
            "fiscal_year",
            { dateAdd: [{ date: "2026-01-31" }, 1, "month"] },
          ],
        },
        as: "fy",
      },
    ];
    const gauge: ChartSettings = {
      type: "gauge",
      version: 1,
      value: "a",
      max: "b",
      min: 0,
    };
    expect(items).toHaveLength(6);
    expect(gauge.type).toBe("gauge");
    // @ts-expect-error a count over an expression needs a name
    const bad: SelectItem = { count: { add: ["a", "b"] } };
    void bad;
  });
});
