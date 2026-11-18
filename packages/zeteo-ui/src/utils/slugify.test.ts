import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(slugify("Larkspur Retail")).toBe("larkspur-retail");
  });

  it("starts with a letter", () => {
    expect(slugify("2026 spend report")).toBe("spend-report");
  });

  it("keeps at most 63 characters and never ends in a hyphen", () => {
    const slug = slugify(`${"a".repeat(62)} b`);
    expect(slug).toBe("a".repeat(62));
  });
});
