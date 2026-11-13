// @module-tag unit
// @module-tag platform
import { approxRowBytes } from "../../adapters/rowSize.js";
import { describe, expect, it } from "vitest";

describe("approxRowBytes", () => {
  it("counts a string by its length", () => {
    expect(approxRowBytes(["x".repeat(300_000)])).toBeGreaterThanOrEqual(
      300_000
    );
    expect(approxRowBytes(["x".repeat(300_000)])).toBeLessThan(300_100);
  });

  it("grows with every value of the row", () => {
    const one = approxRowBytes(["abc"]);
    expect(approxRowBytes(["abc", "abc"])).toBeGreaterThan(one);
    expect(approxRowBytes(["abc", null])).toBeGreaterThan(one);
    expect(approxRowBytes(["abc", 1.5])).toBeGreaterThan(one);
    expect(approxRowBytes(["abc", true])).toBeGreaterThan(one);
  });

  it("counts a parsed JSON value by its text", () => {
    const value = { key: "v".repeat(10_000), list: [1, 2, 3] };
    expect(approxRowBytes([value])).toBeGreaterThanOrEqual(
      JSON.stringify(value).length
    );
  });

  it("is never zero, so an empty row still counts", () => {
    expect(approxRowBytes([])).toBeGreaterThan(0);
  });
});
