// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  IdentityRefSchema,
  RowAccessSchema,
  RowRuleInputSchema,
} from "../../row-rules/schema.js";

const id = (identity: string) => ({ identity });
const nested = (depth: number): unknown =>
  depth === 1 ? { rep: { eq: id("k") } } : { not: nested(depth - 1) };

describe("RowRuleInputSchema", () => {
  it.each([
    ["plain in", { channel: { in: ["Retail", "Wholesale"] } }],
    [
      "relative date",
      { created_at: { gte: { relative: { unit: "day", offset: -90 } } } },
    ],
    [
      "identity in with and",
      {
        and: [
          { rep: { in: id("netsuite_employee_id") } },
          { created_at: { gte: { relative: { unit: "day", offset: -90 } } } },
        ],
      },
    ],
    ["not identity eq", { not: { rep: { eq: id("k") } } }],
    ["identity ne", { rep: { ne: id("k") } }],
    [
      "identity notIn below",
      { rep: { notIn: { identity: "k", below: true } } },
    ],
    ["measure reference still allowed", { total: { gt: { measure: "m" } } }],
    ["nesting at the limit", nested(5)],
  ])("accepts %s", (_n, rule) => {
    expect(RowRuleInputSchema.safeParse(rule).success).toBe(true);
  });

  it.each([
    ["gt identity", { rep: { gt: id("k") } }],
    ["between identity", { rep: { between: [id("k"), 1] } }],
    ["bad key name", { rep: { in: id("Bad Name") } }],
    ["empty key name", { rep: { eq: id("") } }],
    ["extra key on ref", { rep: { eq: { identity: "k", x: 1 } } }],
    ["too deep", nested(6)],
  ])("refuses %s", (_n, rule) => {
    expect(RowRuleInputSchema.safeParse(rule).success).toBe(false);
  });
});

describe("IdentityRefSchema and RowAccessSchema", () => {
  it("checks the key name and below", () => {
    expect(IdentityRefSchema.safeParse({ identity: "a_1" }).success).toBe(true);
    expect(
      IdentityRefSchema.safeParse({ identity: "a", below: "yes" }).success
    ).toBe(false);
    expect(IdentityRefSchema.safeParse({ identity: "1a" }).success).toBe(false);
    expect(
      IdentityRefSchema.safeParse({ identity: "a".repeat(65) }).success
    ).toBe(false);
  });
  it("knows three row access values", () => {
    for (const v of ["unlimited_default", "all", "rule"])
      expect(RowAccessSchema.safeParse(v).success).toBe(true);
    expect(RowAccessSchema.safeParse("none").success).toBe(false);
  });
});
