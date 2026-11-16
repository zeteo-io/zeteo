import type { CalcExpr, Query, SelectItem } from "../types/query.js";
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
});
