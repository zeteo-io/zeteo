import { formatDuration } from "./formatDuration";
import { describe, expect, it } from "vitest";

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [1500, "1.5 s"],
    [61_000, "1 min 1 s"],
    [3_600_000, "1 h 0 min"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
  it("returns a dash for null", () => {
    expect(formatDuration(null)).toBe("—");
  });
});
