import { describe, expect, it } from "vitest";
import { formatDate } from "./formatDate";

describe("formatDate", () => {
  it("formats an ISO timestamp as date and time", () => {
    expect(formatDate("2026-11-14T09:05:00Z")).toMatch(/2026/);
  });
  it("returns a dash for null and the raw text for garbage", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("nope")).toBe("nope");
  });
});
