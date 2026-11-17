// @module-tag unit
// @module-tag platform
import type { RelativeDate } from "../../../adapters/sql/relative.js";
import { describe, expect, it } from "vitest";
import {
  floorToMinute,
  resolveRelative,
} from "../../../adapters/sql/relative.js";

const now = new Date("2026-11-17T10:42:31Z");
const rel = (
  unit: RelativeDate["relative"]["unit"],
  offset: number,
  startOf?: boolean
): RelativeDate => ({ relative: { unit, offset, startOf } });

describe("resolveRelative", () => {
  it.each([
    [rel("day", -30), now, "2026-10-18T10:42:31.000Z"],
    [rel("month", 0, true), now, "2026-11-01T00:00:00.000Z"],
    [rel("week", -1, true), now, "2026-11-09T00:00:00.000Z"],
    [rel("quarter", -1, true), now, "2026-07-01T00:00:00.000Z"],
    [rel("year", 0, true), now, "2026-01-01T00:00:00.000Z"],
    [rel("hour", -2), now, "2026-11-17T08:42:31.000Z"],
    [rel("minute", 0, true), now, "2026-11-17T10:42:00.000Z"],
    [
      rel("month", -1),
      new Date("2026-03-31T00:00:00Z"),
      "2026-02-28T00:00:00.000Z",
    ],
  ])("%j from %s is %s", (r, from, expected) => {
    expect(resolveRelative(r, from).toISOString()).toBe(expected);
  });
});

describe("floorToMinute", () => {
  it("drops seconds and milliseconds", () => {
    expect(
      floorToMinute(new Date("2026-11-17T10:42:31.789Z")).toISOString()
    ).toBe("2026-11-17T10:42:00.000Z");
  });
});
