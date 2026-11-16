import { formatRelative } from "./formatRelative";
import { describe, expect, it } from "vitest";

// Expected text through the same locale the helper uses.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("formatRelative", () => {
  it("says just now under a minute, either way", () => {
    expect(formatRelative(ago(30), NOW)).toBe("just now");
    expect(formatRelative(ago(-30), NOW)).toBe("just now");
  });

  it("picks the largest whole unit, rounding down", () => {
    expect(formatRelative(ago(90), NOW)).toBe(rtf.format(-1, "minute"));
    expect(formatRelative(ago(2 * 3600 + 59 * 60), NOW)).toBe(
      rtf.format(-2, "hour")
    );
    expect(formatRelative(ago(3 * 24 * 3600), NOW)).toBe(rtf.format(-3, "day"));
    expect(formatRelative(ago(15 * 24 * 3600), NOW)).toBe(
      rtf.format(-2, "week")
    );
    expect(formatRelative(ago(400 * 24 * 3600), NOW)).toBe(
      rtf.format(-1, "year")
    );
  });

  it("speaks of the future too", () => {
    expect(formatRelative(ago(-3 * 3600), NOW)).toBe(rtf.format(3, "hour"));
  });

  it("returns a dash for none and the raw text for garbage", () => {
    expect(formatRelative(null, NOW)).toBe("—");
    expect(formatRelative(undefined, NOW)).toBe("—");
    expect(formatRelative("nope", NOW)).toBe("nope");
  });
});
