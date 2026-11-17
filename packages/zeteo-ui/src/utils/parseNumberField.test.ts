import { parseNumberField } from "./parseNumberField";
import { describe, expect, it } from "vitest";

describe("parseNumberField", () => {
  it("is undefined for an empty or blank field", () => {
    expect(parseNumberField("")).toBeUndefined();
    expect(parseNumberField("   ")).toBeUndefined();
  });

  it("reads digits, trimmed", () => {
    expect(parseNumberField(" 12 ")).toBe(12);
    expect(parseNumberField("0")).toBe(0);
  });

  it("is NaN for anything else", () => {
    expect(parseNumberField("1.5")).toBeNaN();
    expect(parseNumberField("-3")).toBeNaN();
    expect(parseNumberField("1e3")).toBeNaN();
    expect(parseNumberField("ten")).toBeNaN();
  });
});
