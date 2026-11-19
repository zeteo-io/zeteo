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
