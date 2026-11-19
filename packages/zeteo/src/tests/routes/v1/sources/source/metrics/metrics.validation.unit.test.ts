// @module-tag unit
// @module-tag platform
import { PreviewMetricSchema } from "../../../../../../routes/v1/sources/source/metrics/preview/schemas.js";
import { UpdateMetricSchema } from "../../../../../../routes/v1/sources/source/metrics/metric/schemas.js";
import { MAX_MEASURE_DESCRIPTION } from "../../../../../../routes/v1/sources/source/measures/schemas.js";
import { CreateMetricSchema } from "../../../../../../routes/v1/sources/source/metrics/schemas.js";
import { describe, expect, it } from "vitest";

const VALID = {
  name: "roas",
  description: "Revenue over spend",
  formula: { div: [{ measure: "revenue" }, { measure: "spend" }] },
};

describe("CreateMetricSchema", () => {
  it("accepts a whole metric", () => {
    expect(CreateMetricSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ["an upper-case name", { name: "Roas" }],
    ["a name of 64 characters", { name: `a${"b".repeat(63)}` }],
    ["a blank description", { description: "   " }],
    [
      "a description too long",
      { description: "x".repeat(MAX_MEASURE_DESCRIPTION + 1) },
    ],
    ["a description holding NUL", { description: "a\u0000b" }],
    ["a formula that is no expression", { formula: { nope: 1 } }],
    ["a table", { table: "orders" }],
    ["a filter", { where: { status: { eq: "paid" } } }],
  ])("refuses %s", (_, change) => {
    expect(CreateMetricSchema.safeParse({ ...VALID, ...change }).success).toBe(
      false
    );
  });

  it.each([["name"], ["description"], ["formula"]])("requires %s", (field) => {
    const body: Record<string, unknown> = { ...VALID };
    delete body[field];
    expect(CreateMetricSchema.safeParse(body).success).toBe(false);
  });
});

describe("UpdateMetricSchema", () => {
  it("accepts any one field and refuses none", () => {
    expect(UpdateMetricSchema.safeParse({ name: "aov" }).success).toBe(true);
    expect(UpdateMetricSchema.safeParse({}).success).toBe(false);
    expect(UpdateMetricSchema.safeParse({ fixed: true }).success).toBe(false);
  });
});

describe("PreviewMetricSchema", () => {
  const range = {
    gte: { relative: { unit: "month", offset: -12, startOf: true } },
  };

  it("accepts a draft alone, bucketed, and within a range", () => {
    expect(PreviewMetricSchema.safeParse({ metric: VALID }).success).toBe(true);
    expect(
      PreviewMetricSchema.safeParse({ metric: VALID, bucket: "month", range })
        .success
    ).toBe(true);
  });

  it.each([
    ["an unknown bucket", { bucket: "fortnight" }],
    ["an empty range", { range: {} }],
    ["a range bound that is no date", { range: { lt: 5 } }],
    ["a draft that is no metric", { metric: { name: "x" } }],
  ])("refuses %s", (_, change) => {
    expect(
      PreviewMetricSchema.safeParse({ metric: VALID, ...change }).success
    ).toBe(false);
  });
});
