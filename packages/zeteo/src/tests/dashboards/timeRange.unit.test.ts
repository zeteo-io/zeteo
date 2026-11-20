// @module-tag unit
// @module-tag platform
import { resolveRelative } from "../../adapters/sql/relative.js";
import { describe, expect, it } from "vitest";
import {
  sqlLanguageSchema,
  sqlQuerySchema,
} from "../../adapters/sql/language.js";
import {
  TIME_RANGE_KEYS,
  TIME_RANGES,
  withTimeFilter,
} from "../../dashboards/timeRange.js";

const NOWS = [
  new Date("2026-11-17T10:42:00Z"), // a Tuesday
  new Date("2026-01-01T00:00:00Z"), // a Thursday, the first minute of a year
  new Date("2024-02-29T23:59:00Z"), // a Thursday, a leap day's last minute
];

describe("TIME_RANGES", () => {
  it("has exactly the nineteen keys", () => {
    expect(Object.keys(TIME_RANGES).sort()).toEqual(
      [
        "last_15_minutes",
        "last_hour",
        "last_6_hours",
        "last_24_hours",
        "last_7_days",
        "last_30_days",
        "last_90_days",
        "last_6_months",
        "last_year",
        "last_2_years",
        "today",
        "this_week",
        "this_month",
        "this_quarter",
        "this_year",
        "previous_week",
        "previous_month",
        "previous_quarter",
        "previous_year",
      ].sort()
    );
    expect([...TIME_RANGE_KEYS].sort()).toEqual(
      Object.keys(TIME_RANGES).sort()
    );
  });

  it.each(NOWS)("every range resolves to start < end at %s", (now) => {
    for (const [key, { start, end }] of Object.entries(TIME_RANGES)) {
      const s = resolveRelative(start, now);
      const e = resolveRelative(end, now);
      expect(s.getTime(), key).toBeLessThan(e.getTime());
    }
  });

  it.each(NOWS)(
    "a 'last' range ends at the start of the next minute, after %s",
    (now) => {
      const end = resolveRelative(TIME_RANGES.last_7_days.end, now);
      expect(end.toISOString()).toBe(
        new Date(now.getTime() + 60_000).toISOString()
      );
      expect(
        resolveRelative(TIME_RANGES.last_7_days.start, now).toISOString()
      ).toBe(new Date(now.getTime() - 7 * 86_400_000).toISOString());
    }
  );

  it("this_week starts on Monday and runs seven days", () => {
    const now = NOWS[0]!;
    expect(
      resolveRelative(TIME_RANGES.this_week.start, now).toISOString()
    ).toBe("2026-11-16T00:00:00.000Z");
    expect(resolveRelative(TIME_RANGES.this_week.end, now).toISOString()).toBe(
      "2026-11-23T00:00:00.000Z"
    );
    expect(
      resolveRelative(TIME_RANGES.previous_week.start, now).toISOString()
    ).toBe("2026-11-09T00:00:00.000Z");
  });

  it("calendar ranges run from the unit's start to the next unit's start", () => {
    const now = NOWS[0]!;
    const at = (key: keyof typeof TIME_RANGES) => [
      resolveRelative(TIME_RANGES[key].start, now).toISOString(),
      resolveRelative(TIME_RANGES[key].end, now).toISOString(),
    ];
    expect(at("today")).toEqual([
      "2026-11-17T00:00:00.000Z",
      "2026-11-18T00:00:00.000Z",
    ]);
    expect(at("this_month")).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
    ]);
    expect(at("previous_month")).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
    expect(at("this_quarter")).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(at("previous_quarter")).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ]);
    expect(at("this_year")).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(at("previous_year")).toEqual([
      "2025-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("matches the brief's this_month and previous_month exactly", () => {
    expect(TIME_RANGES.this_month).toEqual({
      start: { relative: { unit: "month", offset: 0, startOf: true } },
      end: { relative: { unit: "month", offset: 1, startOf: true } },
    });
    expect(TIME_RANGES.previous_month).toEqual({
      start: { relative: { unit: "month", offset: -1, startOf: true } },
      end: { relative: { unit: "month", offset: 0, startOf: true } },
    });
    expect(TIME_RANGES.last_hour.end).toEqual({
      relative: { unit: "minute", offset: 1, startOf: true },
    });
  });
});

describe("withTimeFilter", () => {
  const range = TIME_RANGES.last_30_days;

  it("ANDs the filter onto a stored where", () => {
    const query = {
      source: "s",
      from: "orders",
      select: ["id"],
      where: { status: { eq: "paid" } },
    };
    expect(withTimeFilter(query, "created_at", "last_30_days")).toEqual({
      ...query,
      where: {
        and: [
          { status: { eq: "paid" } },
          { created_at: { gte: range.start } },
          { created_at: { lt: range.end } },
        ],
      },
    });
    // The stored query is not changed.
    expect(query.where).toEqual({ status: { eq: "paid" } });
  });

  it("is the filter alone when there was no where", () => {
    const query = { source: "s", from: "orders", select: ["id"] };
    expect(withTimeFilter(query, "orders.created_at", "last_30_days")).toEqual({
      ...query,
      where: {
        and: [
          { "orders.created_at": { gte: range.start } },
          { "orders.created_at": { lt: range.end } },
        ],
      },
    });
  });

  it("gives a query the language accepts, with and without a where", () => {
    const base = { source: "s", from: "orders", select: ["id"] };
    for (const query of [
      base,
      { ...base, where: { status: { eq: "paid" } } },
    ]) {
      const filtered = withTimeFilter(query, "created_at", "this_quarter");
      expect(sqlQuerySchema.safeParse(filtered).success).toBe(true);
    }
  });

  it("sets a metric query's range for the time column range, replacing the stored one", () => {
    const query = {
      source: "s",
      metrics: ["roas"],
      bucket: "month",
      range: { gte: { date: "2020-01-01" } },
    };
    const filtered = withTimeFilter(query, "range", "last_30_days");
    expect(filtered).toEqual({
      ...query,
      range: { gte: range.start, lt: range.end },
    });
    expect(query.range).toEqual({ gte: { date: "2020-01-01" } });
    expect(sqlLanguageSchema.safeParse(filtered).success).toBe(true);
    const { range: _stored, ...none } = query;
    expect(withTimeFilter(none, "range", "this_year")).toEqual({
      ...none,
      range: {
        gte: TIME_RANGES.this_year.start,
        lt: TIME_RANGES.this_year.end,
      },
    });
  });

  it("keeps a table query's behaviour for a column named range, and a metric query's other columns", () => {
    const table = { source: "s", from: "orders", select: ["id"] };
    expect(withTimeFilter(table, "range", "today")).toEqual({
      ...table,
      where: {
        and: [
          { range: { gte: TIME_RANGES.today.start } },
          { range: { lt: TIME_RANGES.today.end } },
        ],
      },
    });
    // A metric query has no where: the language refuses what this gives.
    const metric = { source: "s", metrics: ["roas"] };
    expect(
      sqlLanguageSchema.safeParse(withTimeFilter(metric, "created_at", "today"))
        .success
    ).toBe(false);
  });

  it("leaves anything but an object as it was", () => {
    expect(withTimeFilter(null, "created_at", "today")).toBe(null);
    expect(withTimeFilter([1], "created_at", "today")).toEqual([1]);
  });
});
