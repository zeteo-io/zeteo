// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  countNodes,
  PERIOD_UNITS,
  sqlLanguage,
  sqlQuerySchema,
} from "../../../adapters/sql/language.js";

// The business-day forms of the language: each parses where it belongs and
// is refused at the exact path of what is wrong.

const base = { source: "shop", from: "orders" };
const calc = (expr: unknown) => ({
  ...base,
  select: [{ calc: expr, as: "x" }],
});
const pathsOf = (value: unknown) => {
  const result = sqlQuerySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.path);
};

describe("sqlQuerySchema: business days", () => {
  it.each<[string, unknown]>([
    ["businessDays over columns", { businessDays: ["a", "b"] }],
    [
      "businessDaysBetween",
      { businessDaysBetween: ["a", { date: "2026-01-01" }] },
    ],
    ...PERIOD_UNITS.map((unit): [string, unknown] => [
      `businessDaysIn by ${unit}`,
      { businessDaysIn: [unit, "a"] },
    ]),
    ["businessDaysInMonth", { businessDaysInMonth: "a" }],
    ["businessDaysElapsed of a date", { businessDaysElapsed: "a" }],
    [
      "businessDaysElapsed with a unit",
      { businessDaysElapsed: ["fiscal_year", "a"] },
    ],
    [
      "businessDaysRemaining with a unit",
      { businessDaysRemaining: ["week", "a"] },
    ],
    ["addBusinessDays by a column", { addBusinessDays: ["a", "n"] }],
    [
      "addBusinessDays by a number",
      { addBusinessDays: [{ relative: { unit: "day", offset: 0 } }, -2.5] },
    ],
    ["the business_day part", { datePart: ["business_day", "a"] }],
    [
      "businessDaysInPeriod",
      { div: [{ sum: "x" }, { businessDaysInPeriod: true }] },
    ],
  ])("parses %s", (_, expr) => {
    expect(pathsOf(calc(expr))).toEqual([]);
  });

  it.each([
    ["a day unit", { businessDaysIn: ["day", "a"] }, ["businessDaysIn", 0]],
    ["no unit", { businessDaysIn: ["a"] }, ["businessDaysIn"]],
    ["a third operand", { businessDays: ["a", "b", "c"] }, ["businessDays"]],
    [
      "an unknown unit with elapsed",
      { businessDaysElapsed: ["hour", "a"] },
      ["businessDaysElapsed", 0],
    ],
    [
      "one operand to addBusinessDays",
      { addBusinessDays: ["a"] },
      ["addBusinessDays"],
    ],
    [
      "businessDaysInPeriod false",
      { businessDaysInPeriod: false },
      ["businessDaysInPeriod"],
    ],
    [
      "a bad date inside",
      { businessDaysRemaining: ["week", { date: 5 }] },
      ["businessDaysRemaining", 1, "date"],
    ],
  ])("refuses %s at its path", (_, expr, path) => {
    expect(pathsOf(calc(expr))).toEqual([["select", 0, "calc", ...path]]);
  });

  it("parses isBusinessDay in a filter and refuses a value that is not a boolean", () => {
    expect(
      pathsOf({
        ...base,
        select: ["id"],
        where: { created_at: { isBusinessDay: false } },
      })
    ).toEqual([]);
    expect(
      pathsOf({
        ...base,
        select: ["id"],
        where: { created_at: { isBusinessDay: "yes" } },
      })
    ).toEqual([["where", "created_at"]]);
  });

  it("counts each function as one operation, its unit as none", () => {
    expect(countNodes({ businessDaysElapsed: ["week", "a"] })).toBe(1);
    expect(countNodes({ businessDaysInPeriod: true })).toBe(1);
    expect(
      countNodes({ addBusinessDays: [{ dateAdd: ["a", 1, "day"] }, "n"] })
    ).toBe(2);
  });

  it("describes the forms in the published JSON Schema", () => {
    const text = JSON.stringify(sqlLanguage.describe());
    for (const key of [
      "businessDaysBetween",
      "businessDaysIn",
      "addBusinessDays",
      "businessDaysInPeriod",
      "business_day",
      "isBusinessDay",
    ]) {
      expect(text).toContain(`"${key}"`);
    }
  });
});
