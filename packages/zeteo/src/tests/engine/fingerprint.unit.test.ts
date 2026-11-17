// @module-tag unit
// @module-tag platform
import { sqlQuerySchema } from "../../adapters/sql/language.js";
import { shopCatalog } from "../support/pure/shopCatalog.js";
import { fingerprintOf } from "../../engine/fingerprint.js";
import type { QueryPlan } from "../../adapters/types.js";
import { planSql } from "../../adapters/sql/plan.js";
import { describe, expect, it } from "vitest";

const now = new Date("2026-11-17T10:42:00Z");
const rows = { limit: 1000, offset: 0 };
const SOURCE = "0190d3e0-0000-7000-8000-000000000001";

const plan = (query: object): QueryPlan => {
  const parsed = sqlQuerySchema.safeParse({
    source: "shop",
    from: "orders",
    select: ["id", "status"],
    ...query,
  });
  if (!parsed.success) throw parsed.error;
  return planSql(parsed.data, shopCatalog(), { now });
};

/** The same object with its keys in reverse order, all the way down. */
const reversed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reversed(v)])
    );
  }
  return value;
};

describe("fingerprintOf", () => {
  it("is a SHA-256 hex digest", () => {
    expect(fingerprintOf(SOURCE, plan({}), rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", () => {
    const p = plan({ where: { status: { eq: "paid" } } });
    expect(fingerprintOf(SOURCE, reversed(p) as QueryPlan, rows)).toBe(
      fingerprintOf(SOURCE, p, rows)
    );
  });

  it("is the same for the same query planned twice", () => {
    const q = { where: { status: { eq: "paid" } } };
    expect(fingerprintOf(SOURCE, plan(q), rows)).toBe(
      fingerprintOf(SOURCE, plan(q), rows)
    );
  });

  it("changes with a bound value", () => {
    expect(
      fingerprintOf(SOURCE, plan({ where: { status: { eq: "paid" } } }), rows)
    ).not.toBe(
      fingerprintOf(SOURCE, plan({ where: { status: { eq: "open" } } }), rows)
    );
  });

  it("changes with the row cap or the offset", () => {
    const p = plan({});
    const base = fingerprintOf(SOURCE, p, rows);
    expect(fingerprintOf(SOURCE, p, { limit: 5000, offset: 0 })).not.toBe(base);
    expect(fingerprintOf(SOURCE, p, { limit: 1000, offset: 10 })).not.toBe(
      base
    );
  });

  it("changes with the source", () => {
    const p = plan({});
    expect(
      fingerprintOf("0190d3e0-0000-7000-8000-000000000002", p, rows)
    ).not.toBe(fingerprintOf(SOURCE, p, rows));
  });

  it("differs for one saved query filtered on two different time columns", () => {
    const since = { gte: { relative: { unit: "day", offset: -7 } } };
    expect(
      fingerprintOf(SOURCE, plan({ where: { created_at: since } }), rows)
    ).not.toBe(
      fingerprintOf(SOURCE, plan({ where: { ordered_on: since } }), rows)
    );
  });

  it("differs for one saved query over two different time ranges", () => {
    const since = (offset: number) => ({
      where: { created_at: { gte: { relative: { unit: "day", offset } } } },
    });
    expect(fingerprintOf(SOURCE, plan(since(-7)), rows)).not.toBe(
      fingerprintOf(SOURCE, plan(since(-30)), rows)
    );
  });
});
