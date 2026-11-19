// @module-tag unit
// @module-tag platform
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";

const now = new Date("2026-11-19T15:00:00Z");
const yesterday = { relative: { unit: "day", offset: -1 } };

const withCalendar = (
  calendar: Partial<VisibleCatalog["calendar"]>
): VisibleCatalog => ({
  ...shopCatalog(),
  calendar: { ...DEFAULT_CALENDAR, ...calendar },
});

const calcQuery = (fn: object) => ({
  source: "shop",
  from: "orders",
  select: [{ calc: { div: [{ sum: "total" }, fn] }, as: "daily" }],
});

const literalOf = (fn: object, catalog = shopCatalog()) => {
  const plan = planSql(sqlQuerySchema.parse(calcQuery(fn)), catalog, { now });
  const item = plan.select[0] as unknown as {
    expr: { args: [unknown, unknown] };
  };
  return item.expr.args[1];
};

const refusal = (fn: object) => {
  try {
    planSql(sqlQuerySchema.parse(calcQuery(fn)), shopCatalog(), { now });
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return { code: err.code, path: err.path, message: err.message };
  }
  throw new Error("the query was planned");
};

const number = (value: number) => ({ kind: "literal", value, type: "number" });

describe("planSql: calendar functions", () => {
  it("binds the business days in the month of yesterday", () => {
    expect(literalOf({ businessDaysInMonth: yesterday })).toEqual(number(21));
  });

  it("binds the business days elapsed through yesterday", () => {
    expect(literalOf({ businessDaysElapsed: yesterday })).toEqual(number(13));
  });

  it("binds the business days remaining after a date", () => {
    expect(
      literalOf({ businessDaysRemaining: { date: "2026-11-19" } })
    ).toEqual(number(7));
  });

  it("binds the business days between two dates, inclusive", () => {
    expect(
      literalOf({
        businessDays: [{ date: "2026-11-02" }, { date: "2026-11-06" }],
      })
    ).toEqual(number(5));
  });

  it("counts a holiday out", () => {
    const catalog = withCalendar({
      holidays: new Map([["2026-11-26", "Thanksgiving"]]),
    });
    expect(literalOf({ businessDaysInMonth: yesterday }, catalog)).toEqual(
      number(20)
    );
  });

  it("takes a timestamp as its date in the calendar's time zone", () => {
    const fn = { businessDaysElapsed: { timestamp: "2026-11-02T03:00:00Z" } };
    expect(
      literalOf(fn, withCalendar({ timeZone: "America/New_York" }))
    ).toEqual(number(0));
    expect(literalOf(fn)).toEqual(number(1));
  });

  it("refuses a column argument", () => {
    expect(refusal({ businessDaysInMonth: "created_at" })).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "div", 1, "businessDaysInMonth"],
      message:
        "calendar functions take a date or a relative date in this version",
    });
  });

  it("refuses a column inside businessDays at its own position", () => {
    expect(
      refusal({ businessDays: [{ date: "2026-11-02" }, "created_at"] }).path
    ).toEqual(["select", 0, "calc", "div", 1, "businessDays", 1]);
  });

  it("counts each function as one operation", () => {
    const parsed = sqlQuerySchema.safeParse(
      calcQuery({ businessDays: [{ date: "2026-11-02" }, yesterday] })
    );
    expect(parsed.success).toBe(true);
  });
});
