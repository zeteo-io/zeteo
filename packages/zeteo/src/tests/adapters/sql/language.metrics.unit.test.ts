// @module-tag unit
// @module-tag platform
import { isMetricBody } from "../../../adapters/sql/language.js";
import { describe, expect, it } from "vitest";

describe("isMetricBody", () => {
  it("is true only for a plain object with a metrics key", () => {
    expect(isMetricBody({ metrics: ["a"] })).toBe(true);
    expect(isMetricBody({ from: "t" })).toBe(false);
    expect(isMetricBody(null)).toBe(false);
    expect(isMetricBody(["metrics"])).toBe(false);
    expect(isMetricBody("metrics")).toBe(false);
    expect(isMetricBody(undefined)).toBe(false);
  });
});
