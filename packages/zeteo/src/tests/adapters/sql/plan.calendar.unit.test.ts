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

interface MonthsNode {
  kind: string;
  arg: { kind: string };
  argType: string;
  months: string[];
  counts: number[];
  type: string;
}

const itemOf = (
  calc: object,
  catalog = shopCatalog(),
  at: Date = now
): { level: string; expr: MonthsNode } =>
  planSql(
    sqlQuerySchema.parse({
      source: "shop",
      from: "orders",
      select: [{ calc, as: "n" }],
    }),
    catalog,
    { now: at }
  ).select[0] as unknown as { level: string; expr: MonthsNode };

describe("planSql: businessDaysInMonth over a column", () => {
  const monthly = (catalog = shopCatalog()) =>
    itemOf({ businessDaysInMonth: "created_at" }, catalog).expr;

  it("plans a timestamp column, with the months 25 years either side of now", () => {
    const node = monthly();
    expect(node).toMatchObject({
      kind: "calendarMonths",
      argType: "timestamp",
      type: "number",
    });
    expect(node.months).toHaveLength(601);
    expect(node.counts).toHaveLength(601);
    expect(node.months[0]).toBe("2001-11-01");
    expect(node.months[300]).toBe("2026-11-01");
    expect(node.months.at(-1)).toBe("2051-11-01");
    expect(node.counts[300]).toBe(21);
  });

  it("carries the calendar's holidays in the counts", () => {
    const node = monthly(
      withCalendar({ holidays: new Map([["2026-11-26", "Thanksgiving"]]) })
    );
    expect(node.counts[300]).toBe(20);
  });

  it("centres the window on now in the calendar's time zone", () => {
    const late = new Date("2026-11-30T23:30:00Z");
    const node = itemOf(
      { businessDaysInMonth: "created_at" },
      withCalendar({ timeZone: "Pacific/Auckland" }),
      late
    ).expr;
    expect(node.months[300]).toBe("2026-12-01");
  });

  it("plans a date operation as the argument", () => {
    const node = itemOf({
      businessDaysInMonth: { dateAdd: ["created_at", 1, "month"] },
    }).expr;
    expect(node.arg.kind).toBe("dateAdd");
  });

  it("is row-level over a bare column and group-level inside an aggregate", () => {
    expect(itemOf({ businessDaysInMonth: "created_at" }).level).toBe("row");
    expect(itemOf({ max: { businessDaysInMonth: "created_at" } }).level).toBe(
      "group"
    );
  });

  it("still folds a date, a timestamp and a relative date to a literal", () => {
    expect(literalOf({ businessDaysInMonth: yesterday })).toEqual(number(21));
    expect(literalOf({ businessDaysInMonth: { date: "2026-11-19" } })).toEqual(
      number(21)
    );
    expect(
      literalOf({ businessDaysInMonth: { timestamp: "2026-02-10T00:00:00Z" } })
    ).toEqual(number(20));
  });
});

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

  it("refuses a column argument to the other calendar functions", () => {
    for (const fn of [
      "businessDaysElapsed",
      "businessDaysRemaining",
    ] as const) {
      expect(refusal({ [fn]: "created_at" })).toEqual({
        code: "invalid_operator",
        path: ["select", 0, "calc", "div", 1, fn],
        message:
          "calendar functions take a date or a relative date in this version",
      });
    }
  });

  it("refuses a column inside businessDays at its own position", () => {
    expect(
      refusal({ businessDays: [{ date: "2026-11-02" }, "created_at"] }).path
    ).toEqual(["select", 0, "calc", "div", 1, "businessDays", 1]);
  });

  it("refuses a non-date argument to businessDaysInMonth", () => {
    expect(refusal({ businessDaysInMonth: "status" })).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "div", 1, "businessDaysInMonth"],
      message:
        'businessDaysInMonth needs a date or timestamp; "status" is text',
    });
  });

  it("counts each function as one operation", () => {
    const parsed = sqlQuerySchema.safeParse(
      calcQuery({ businessDays: [{ date: "2026-11-02" }, yesterday] })
    );
    expect(parsed.success).toBe(true);
  });
});
