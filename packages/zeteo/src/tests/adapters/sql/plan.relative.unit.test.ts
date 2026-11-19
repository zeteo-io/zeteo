// @module-tag unit
// @module-tag platform
import { resolveRelative } from "../../../adapters/sql/relative.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";

const now = new Date("2026-11-17T10:42:00Z");
const week = { relative: { unit: "day", offset: -7 } } as const;

const parse = (where: object) =>
  sqlQuerySchema.safeParse({
    source: "shop",
    from: "orders",
    select: ["id"],
    where,
  });

const plan = (where: object) => {
  const parsed = parse(where);
  if (!parsed.success) throw parsed.error;
  return planSql(parsed.data, shopCatalog(), { now });
};

const valueOf = (where: object) =>
  (plan(where).where as unknown as { value: unknown }).value;

describe("planSql: relative dates", () => {
  it("binds a timestamp column's relative value as an ISO timestamp", () => {
    expect(valueOf({ created_at: { gte: week } })).toBe(
      resolveRelative(week, now).toISOString()
    );
  });

  it("binds a date column's relative value as YYYY-MM-DD", () => {
    expect(valueOf({ ordered_on: { gte: week } })).toBe("2026-11-10");
  });

  it("resolves each side of between", () => {
    const { where } = plan({
      created_at: {
        between: [week, { relative: { unit: "day", offset: 0 } }],
      },
    }) as unknown as { where: { low: unknown; high: unknown } };
    expect(where.low).toBe("2026-11-10T10:42:00.000Z");
    expect(where.high).toBe("2026-11-17T10:42:00.000Z");
  });

  it("refuses a relative value on a text column at the value's path", () => {
    try {
      plan({ status: { eq: week } });
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe("invalid_value");
      expect((err as QueryError).path).toEqual(["where", "status", "eq"]);
      return;
    }
    throw new Error("the query was planned");
  });

  it("refuses an offset beyond 1000", () => {
    expect(
      parse({
        created_at: { gte: { relative: { unit: "day", offset: 5000 } } },
      }).success
    ).toBe(false);
  });

  it("refuses a relative value inside in", () => {
    expect(parse({ created_at: { in: [week] } }).success).toBe(false);
  });

  it("refuses unknown keys in a relative value", () => {
    expect(
      parse({
        created_at: {
          gte: { relative: { unit: "day", offset: 1, extra: true } },
        },
      }).success
    ).toBe(false);
  });
});

describe("planSql: relative dates in the calendar's time zone", () => {
  it("binds a date column's relative value as the local date", () => {
    const parsed = parse({
      ordered_on: { gte: { relative: { unit: "day", offset: -1 } } },
    });
    if (!parsed.success) throw parsed.error;
    const catalog = {
      ...shopCatalog(),
      calendar: { ...DEFAULT_CALENDAR, timeZone: "America/Chicago" },
    };
    const planned = planSql(parsed.data, catalog, {
      now: new Date("2026-11-19T03:00:00Z"),
    });
    expect((planned.where as unknown as { value: unknown }).value).toBe(
      "2026-11-17"
    );
  });
});

describe("planSql: dates in expressions", () => {
  const planCalc = (calc: unknown, calendar = DEFAULT_CALENDAR) =>
    planSql(
      sqlQuerySchema.parse({
        source: "shop",
        from: "orders",
        select: [{ calc, as: "x" }],
      }),
      { ...shopCatalog(), calendar },
      { now: new Date("2026-11-19T03:00:00Z") }
    );
  const refusal = (calc: unknown) => {
    try {
      planCalc(calc);
    } catch (err) {
      if (!(err instanceof QueryError)) throw err;
      return { code: err.code, path: err.path };
    }
    throw new Error("the query was planned");
  };
  const exprOf = (calc: unknown, calendar = DEFAULT_CALENDAR) => {
    const item = planCalc(calc, calendar).select[0]!;
    if (item.kind !== "calc") throw new Error("not a calc");
    return item;
  };

  it("types dateAdd as its operand's type", () => {
    expect(exprOf({ dateAdd: ["created_at", 1, "month"] }).type).toBe(
      "timestamp"
    );
    expect(exprOf({ dateAdd: ["ordered_on", -2, "week"] })).toMatchObject({
      type: "date",
      expr: { kind: "dateAdd", amount: -2, unit: "week", type: "date" },
    });
  });

  it("refuses arithmetic on a timestamp and date operations on other types", () => {
    expect(refusal({ add: ["created_at", 1] })).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "add", 0],
    });
    expect(refusal({ dateAdd: ["total", 1, "day"] })).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "dateAdd", 0],
    });
    expect(refusal({ datePart: ["month", "status"] })).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "datePart", 1],
    });
    expect(refusal({ dateDiff: ["day", "created_at", "id"] })).toEqual({
      code: "invalid_operator",
      path: ["select", 0, "calc", "dateDiff", 2],
    });
  });

  it("refuses a date literal that is not a date", () => {
    expect(
      refusal({ dateAdd: [{ date: "2026-02-30" }, 1, "day"] })
    ).toMatchObject({
      code: "invalid_value",
      path: ["select", 0, "calc", "dateAdd", 0, "date"],
    });
    expect(
      refusal({ dateAdd: [{ timestamp: "2026-02-01T10:00:00" }, 1, "day"] })
    ).toMatchObject({ code: "invalid_value" });
  });

  it("plans a date literal as a bound date and a timestamp as one", () => {
    expect(
      exprOf({ coalesce: ["ordered_on", { date: "2026-01-31" }] }).expr
    ).toMatchObject({
      kind: "op",
      type: "date",
      args: [
        { kind: "column" },
        { kind: "literal", value: "2026-01-31", type: "date" },
      ],
    });
    expect(
      exprOf({
        coalesce: ["created_at", { timestamp: "2026-01-31T10:00:00+02:00" }],
      }).expr
    ).toMatchObject({
      args: [
        { kind: "column" },
        {
          kind: "literal",
          value: "2026-01-31T10:00:00+02:00",
          type: "timestamp",
        },
      ],
    });
  });

  it("plans a relative literal as the date in the calendar's time zone", () => {
    const calc = {
      dateDiff: [
        "day",
        { relative: { unit: "day", offset: -1 } },
        "created_at",
      ],
    };
    expect(exprOf(calc).expr).toMatchObject({
      kind: "dateDiff",
      operand: "timestamp",
      start: { kind: "literal", value: "2026-11-18", type: "date" },
    });
    expect(
      exprOf(calc, { ...DEFAULT_CALENDAR, timeZone: "America/Chicago" }).expr
    ).toMatchObject({
      start: { kind: "literal", value: "2026-11-17", type: "date" },
    });
  });

  it("reads fiscal parts from the calendar and no other part", () => {
    const fiscal = { ...DEFAULT_CALENDAR, fiscalYearStartMonth: 4 };
    expect(
      exprOf({ datePart: ["fiscal_year", "ordered_on"] }, fiscal).expr
    ).toMatchObject({ kind: "datePart", fiscalStartMonth: 4, type: "number" });
    expect(
      exprOf({ datePart: ["month", "ordered_on"] }, fiscal).expr
    ).toMatchObject({ fiscalStartMonth: 1 });
  });

  it("takes dates in min, max and case, and refuses them in other operations", () => {
    expect(
      planSql(
        sqlQuerySchema.parse({
          source: "shop",
          from: "orders",
          select: [{ max: { dateAdd: ["created_at", 1, "day"] }, as: "m" }],
        }),
        shopCatalog()
      ).select[0]
    ).toMatchObject({ kind: "calc", level: "group", type: "timestamp" });
    expect(
      exprOf({
        case: {
          when: [{ if: { id: { eq: 1 } }, then: "ordered_on" }],
          else: { date: "2026-01-01" },
        },
      }).type
    ).toBe("date");
    expect(refusal({ abs: { date: "2026-01-01" } }).code).toBe(
      "invalid_operator"
    );
    expect(refusal({ concat: ["ordered_on", "status"] }).code).toBe(
      "invalid_operator"
    );
  });

  it("counts an operation in a date expression but not a literal", () => {
    expect(
      sqlQuerySchema.safeParse({
        source: "shop",
        from: "orders",
        select: Array.from({ length: 50 }, (_, i) => ({
          calc: { dateDiff: ["day", { date: "2026-01-01" }, "created_at"] },
          as: `d${i}`,
        })),
      }).success
    ).toBe(true);
    expect(
      sqlQuerySchema.safeParse({
        source: "shop",
        from: "orders",
        select: Array.from({ length: 51 }, (_, i) => ({
          calc: { datePart: ["year", { dateAdd: ["created_at", 1, "day"] }] },
          as: `d${i}`,
        })),
      }).success
    ).toBe(false);
  });
});
