// @module-tag unit
// @module-tag platform
import { PreviewMeasureSchema } from "../../../../../../routes/v1/sources/source/measures/preview/schemas.js";
import { UpdateMeasureSchema } from "../../../../../../routes/v1/sources/source/measures/measure/schemas.js";
import { describe, expect, it } from "vitest";
import {
  CreateMeasureSchema,
  MAX_MEASURE_DESCRIPTION,
} from "../../../../../../routes/v1/sources/source/measures/schemas.js";

const VALID = {
  name: "paid_revenue",
  description: "Revenue of paid orders",
  table: "orders",
  formula: { sum: "total" },
  where: { status: { eq: "paid" } },
};

describe("CreateMeasureSchema", () => {
  it("accepts a whole measure, with or without a filter", () => {
    expect(CreateMeasureSchema.safeParse(VALID).success).toBe(true);
    const { where: _w, ...noWhere } = VALID;
    expect(CreateMeasureSchema.safeParse(noWhere).success).toBe(true);
    expect(
      CreateMeasureSchema.safeParse({ ...VALID, where: null }).success
    ).toBe(true);
  });

  it.each([
    ["an upper-case name", { name: "Paid" }],
    ["a name starting with a digit", { name: "1paid" }],
    ["a name with a dash", { name: "paid-revenue" }],
    ["a name of 64 characters", { name: `a${"b".repeat(63)}` }],
    ["an empty description", { description: "" }],
    ["a blank description", { description: "   " }],
    [
      "a description too long",
      { description: "x".repeat(MAX_MEASURE_DESCRIPTION + 1) },
    ],
    ["a description holding NUL", { description: "a\u0000b" }],
    ["an empty table", { table: "" }],
    ["a formula that is no expression", { formula: { nope: 1 } }],
    ["a formula with two keys", { formula: { sum: "a", max: "b" } }],
    ["a filter with an unknown operator", { where: { status: { is: 1 } } }],
    ["an unknown field", { joins: ["customers"] }],
  ])("refuses %s", (_, change) => {
    expect(CreateMeasureSchema.safeParse({ ...VALID, ...change }).success).toBe(
      false
    );
  });

  it.each([["name"], ["description"], ["table"], ["formula"]])(
    "requires %s",
    (field) => {
      const body: Record<string, unknown> = { ...VALID };
      delete body[field];
      expect(CreateMeasureSchema.safeParse(body).success).toBe(false);
    }
  );

  it("accepts a name of 63 characters and a description of 2,000", () => {
    expect(
      CreateMeasureSchema.safeParse({
        ...VALID,
        name: `a${"b".repeat(62)}`,
        description: "x".repeat(MAX_MEASURE_DESCRIPTION),
      }).success
    ).toBe(true);
  });
});

describe("UpdateMeasureSchema", () => {
  it("accepts any one field, and where: null", () => {
    expect(UpdateMeasureSchema.safeParse({ description: "x" }).success).toBe(
      true
    );
    expect(UpdateMeasureSchema.safeParse({ where: null }).success).toBe(true);
  });

  it("refuses an empty change and an unknown field", () => {
    expect(UpdateMeasureSchema.safeParse({}).success).toBe(false);
    expect(UpdateMeasureSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});

describe("PreviewMeasureSchema", () => {
  it("accepts a draft alone or with a bucket", () => {
    expect(PreviewMeasureSchema.safeParse({ measure: VALID }).success).toBe(
      true
    );
    expect(
      PreviewMeasureSchema.safeParse({
        measure: VALID,
        bucket: { unit: "fiscal_quarter", column: "created_at" },
      }).success
    ).toBe(true);
  });

  it("refuses an unknown bucket unit and a missing draft", () => {
    expect(
      PreviewMeasureSchema.safeParse({
        measure: VALID,
        bucket: { unit: "hour", column: "created_at" },
      }).success
    ).toBe(false);
    expect(PreviewMeasureSchema.safeParse({}).success).toBe(false);
  });
});
