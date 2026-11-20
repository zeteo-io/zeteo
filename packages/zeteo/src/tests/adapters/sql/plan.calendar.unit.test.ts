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

interface PlannedItem {
  level: string;
  type: string;
  expr: Record<string, unknown> & { kind: string };
}

const itemOf = (calc: object, catalog = shopCatalog()): PlannedItem =>
  planSql(
    sqlQuerySchema.parse({
      source: "shop",
      from: "orders",
      select: [{ calc, as: "n" }],
    }),
    catalog,
    { now }
  ).select[0] as unknown as PlannedItem;

const refusalOf = (query: object, catalog = shopCatalog()) => {
  try {
    planSql(sqlQuerySchema.parse({ source: "shop", ...query }), catalog, {
      now,
    });
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return { code: err.code, path: err.path, message: err.message };
  }
  throw new Error("the query was planned");
};

describe("planSql: business days over columns", () => {
  it("plans each function over a date or timestamp column, row-level, and inside an aggregate, group-level", () => {
    const cases: [object, object][] = [
      [
        { businessDays: ["ordered_on", "created_at"] },
        { kind: "businessDays", fn: "inclusive" },
      ],
      [
        { businessDaysBetween: ["ordered_on", "created_at"] },
        { kind: "businessDays", fn: "between" },
      ],
      [
        { businessDaysIn: ["fiscal_quarter", "ordered_on"] },
        { kind: "businessPeriod", fn: "in", unit: "fiscal_quarter" },
      ],
      [
        { businessDaysInMonth: "created_at" },
        { kind: "businessPeriod", fn: "in", unit: "month" },
      ],
      [
        { businessDaysElapsed: ["week", "ordered_on"] },
        { kind: "businessPeriod", fn: "elapsed", unit: "week" },
      ],
      [
        { businessDaysRemaining: "ordered_on" },
        { kind: "businessPeriod", fn: "remaining", unit: "month" },
      ],
      [
        { datePart: ["business_day", "created_at"] },
        { kind: "businessPeriod", fn: "elapsed", unit: "month" },
      ],
    ];
    for (const [calc, expected] of cases) {
      const item = itemOf(calc);
      expect(item.expr, JSON.stringify(calc)).toMatchObject(expected);
      expect(item.level).toBe("row");
      expect(item.type).toBe("number");
      expect(itemOf({ max: calc }).level).toBe("group");
    }
    const added = itemOf({ addBusinessDays: ["created_at", "customer_id"] });
    expect(added.type).toBe("date");
    expect(added.expr).toMatchObject({
      kind: "addBusinessDays",
      date: { type: "timestamp" },
      amount: { kind: "column" },
    });
  });

  it("reads a fiscal unit's start month from the calendar, and no other unit's", () => {
    const april = withCalendar({ fiscalYearStartMonth: 4 });
    expect(
      itemOf({ businessDaysIn: ["fiscal_year", "ordered_on"] }, april).expr
        .fiscalStartMonth
    ).toBe(4);
    expect(
      itemOf({ businessDaysIn: ["year", "ordered_on"] }, april).expr
        .fiscalStartMonth
    ).toBe(1);
  });

  it("carries the calendar: working weekdays, holidays as ordinals and their shifts, and the zone", () => {
    const calendar = itemOf(
      { businessDaysInMonth: "created_at" },
      withCalendar({
        workingDays: [1, 2, 3, 4, 6],
        holidays: new Map([
          ["2026-11-26", "Thanksgiving"],
          ["2026-11-27", "a Friday: not a working day here"],
          ["2026-11-28", "a Saturday that is"],
          ["1899-12-25", "before the anchor"],
        ]),
        timeZone: "America/New_York",
      })
    ).expr.calendar as {
      weekdays: number[];
      holidays: number[];
      shifts: number[];
      zone: { name: string; from: string; to: string };
    };
    expect(calendar.weekdays).toEqual([0, 1, 2, 3, 5]);
    expect(calendar.holidays).toHaveLength(2);
    expect(calendar.holidays[1]! - calendar.holidays[0]!).toBe(1);
    expect(calendar.shifts).toEqual([
      calendar.holidays[0],
      calendar.holidays[0],
    ]);
    expect(calendar.zone).toMatchObject({
      name: "America/New_York",
      from: "2001-01-01T00:00:00.000Z",
      to: "2052-01-01T00:00:00.000Z",
    });
    expect(
      itemOf({ businessDaysInMonth: "created_at" }).expr.calendar
    ).not.toHaveProperty("zone");
  });

  it("plans a different query when the calendar changes", () => {
    const plan = (catalog: VisibleCatalog) =>
      JSON.stringify(itemOf({ businessDaysInMonth: "ordered_on" }, catalog));
    expect(plan(shopCatalog())).not.toBe(
      plan(withCalendar({ holidays: new Map([["2026-11-26", "x"]]) }))
    );
    expect(plan(shopCatalog())).not.toBe(
      plan(withCalendar({ workingDays: [1, 2, 3, 4] }))
    );
  });

  it("refuses a non-date operand and a non-number step at their own paths", () => {
    expect(
      refusalOf({
        from: "orders",
        select: [{ calc: { businessDaysIn: ["week", "status"] }, as: "n" }],
      })
    ).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "businessDaysIn", 1],
      message: 'businessDaysIn needs a date or timestamp; "status" is text',
    });
    expect(
      refusalOf({
        from: "orders",
        select: [
          { calc: { addBusinessDays: ["ordered_on", "status"] }, as: "n" },
        ],
      })
    ).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "addBusinessDays", 1],
      message:
        'addBusinessDays takes a number of business days; "status" is text',
    });
    expect(
      refusalOf({
        from: "orders",
        select: [{ calc: { datePart: ["business_day", "total"] }, as: "n" }],
      }).path
    ).toEqual(["select", 0, "calc", "datePart", 1]);
  });

  it("refuses businessDaysInPeriod outside a metric's formula", () => {
    expect(
      refusalOf({
        from: "orders",
        select: [
          {
            calc: { div: [{ sum: "total" }, { businessDaysInPeriod: true }] },
            as: "n",
          },
        ],
      })
    ).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "div", 1, "businessDaysInPeriod"],
      message:
        "businessDaysInPeriod is for a metric's formula only; in a query, use businessDaysIn",
    });
  });
});

describe("planSql: the isBusinessDay filter", () => {
  it("filters a date or timestamp column in where and in a case's if", () => {
    const plan = planSql(
      sqlQuerySchema.parse({
        source: "shop",
        from: "orders",
        select: [
          "id",
          {
            calc: {
              case: {
                when: [
                  { if: { ordered_on: { isBusinessDay: false } }, then: 1 },
                ],
                else: 0,
              },
            },
            as: "off",
          },
        ],
        where: { created_at: { isBusinessDay: true } },
      }),
      shopCatalog(),
      { now }
    );
    expect(plan.where).toMatchObject({ kind: "businessDay", is: true });
    const off = plan.select[1] as unknown as {
      expr: { branches: { when: object }[] };
    };
    expect(off.expr.branches[0]!.when).toMatchObject({
      kind: "businessDay",
      is: false,
    });
  });

  it("refuses a column that is not a date or timestamp", () => {
    expect(
      refusalOf({
        from: "orders",
        select: ["id"],
        where: { total: { isBusinessDay: true } },
      })
    ).toEqual({
      code: "invalid_operator",
      path: ["where", "total", "isBusinessDay"],
      message: 'isBusinessDay does not apply to "total", a number column',
    });
  });

  it("refuses it in having, which filters groups", () => {
    expect(
      refusalOf({
        from: "orders",
        select: [{ max: "ordered_on", as: "last" }],
        having: { last: { isBusinessDay: true } },
      })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["having", "last", "isBusinessDay"],
    });
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

  it("folds the new functions over literals to bound values", () => {
    expect(
      literalOf({
        businessDaysBetween: [{ date: "2026-11-20" }, { date: "2026-11-23" }],
      })
    ).toEqual(number(1));
    expect(
      literalOf({ businessDaysIn: ["quarter", { date: "2026-11-19" }] })
    ).toEqual(number(66));
    expect(
      literalOf({ businessDaysRemaining: ["week", { date: "2026-11-19" }] })
    ).toEqual(number(1));
    expect(
      literalOf({ datePart: ["business_day", { date: "2026-11-19" }] })
    ).toEqual(number(14));
    expect(
      itemOf({
        dateDiff: [
          "day",
          "ordered_on",
          { addBusinessDays: [{ date: "2026-11-21" }, 1] },
        ],
      }).expr.end
    ).toEqual({ kind: "literal", value: "2026-11-23", type: "date" });
  });

  it("leaves to the compiler, which gives null, what the calendar cannot count", () => {
    expect(
      literalOf({
        businessDays: [{ date: "1899-12-31" }, { date: "2026-11-02" }],
      })
    ).toMatchObject({ kind: "businessDays" });
    expect(
      literalOf(
        { businessDaysElapsed: { timestamp: "1990-01-01T00:00:00Z" } },
        withCalendar({ timeZone: "America/New_York" })
      )
    ).toMatchObject({ kind: "businessPeriod" });
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
