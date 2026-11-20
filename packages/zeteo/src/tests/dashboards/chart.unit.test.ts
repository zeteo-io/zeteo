// @module-tag unit
// @module-tag platform
import type { ColumnType } from "../../adapters/types.js";
import { describe, expect, it } from "vitest";
import {
  chartProblems,
  chartSchema,
  DEFAULT_SIZES,
  type ChartSettings,
} from "../../dashboards/chart.js";

const col = (name: string, type: ColumnType) => ({ name, type });

const columns = [
  // A bucket, a date in any calendar zone.
  col("month", "date"),
  col("at", "timestamp"),
  col("day", "date"),
  col("revenue", "number"),
  col("orders", "number"),
  col("region", "text"),
  col("paid", "boolean"),
];

const ordered = { orderBy: [{ month: "desc" }] };

describe("chartSchema", () => {
  it("accepts one of each type", () => {
    const charts: unknown[] = [
      {
        type: "stat",
        version: 1,
        value: "revenue",
        compare: "next_row",
        unit: "USD",
        decimals: 2,
      },
      {
        type: "line",
        version: 1,
        x: "month",
        y: ["revenue"],
        series: "region",
        legend: "none",
      },
      {
        type: "area",
        version: 1,
        x: "month",
        y: ["revenue", "orders"],
        stacked: true,
      },
      {
        type: "bar",
        version: 1,
        x: "region",
        y: ["revenue"],
        stacked: true,
        horizontal: true,
      },
      {
        type: "pie",
        version: 1,
        label: "region",
        value: "revenue",
        donut: true,
      },
      {
        type: "table",
        version: 1,
        columns: ["region", "revenue"],
        decimals: 0,
      },
      { type: "table", version: 1 },
    ];
    for (const chart of charts) {
      expect(chartSchema.safeParse(chart).success, JSON.stringify(chart)).toBe(
        true
      );
    }
  });

  it.each([
    ["an unknown key", { type: "table", version: 1, colour: "red" }],
    ["another version", { type: "table", version: 2 }],
    ["an unknown type", { type: "radar", version: 1 }],
    ["no y", { type: "line", version: 1, x: "month", y: [] }],
    [
      "eleven y",
      { type: "bar", version: 1, x: "region", y: Array(11).fill("revenue") },
    ],
    [
      "stacked on a line",
      { type: "line", version: 1, x: "month", y: ["revenue"], stacked: true },
    ],
    [
      "a long unit",
      { type: "stat", version: 1, value: "revenue", unit: "x".repeat(21) },
    ],
    [
      "seven decimals",
      { type: "stat", version: 1, value: "revenue", decimals: 7 },
    ],
    [
      "compare other than next_row",
      { type: "stat", version: 1, value: "revenue", compare: "prev" },
    ],
    [
      "fifty-one columns",
      { type: "table", version: 1, columns: Array(51).fill("region") },
    ],
    [
      "another legend",
      {
        type: "pie",
        version: 1,
        label: "region",
        value: "revenue",
        legend: "left",
      },
    ],
  ])("refuses %s", (_, chart) => {
    expect(chartSchema.safeParse(chart).success).toBe(false);
  });
});

describe("chartProblems", () => {
  const problems = (
    chart: ChartSettings,
    query: { orderBy?: unknown } = ordered
  ) => chartProblems(chart, columns, query);

  it("finds none in settings that fit", () => {
    expect(
      problems({
        type: "stat",
        version: 1,
        value: "revenue",
        compare: "next_row",
      })
    ).toEqual([]);
    expect(
      problems({
        type: "line",
        version: 1,
        x: "day",
        y: ["revenue"],
        series: "region",
      })
    ).toEqual([]);
    expect(
      problems({ type: "area", version: 1, x: "revenue", y: ["orders"] })
    ).toEqual([]);
    for (const x of ["month", "at"]) {
      expect(problems({ type: "line", version: 1, x, y: ["orders"] })).toEqual(
        []
      );
    }
    expect(
      problems({ type: "bar", version: 1, x: "paid", y: ["revenue"] })
    ).toEqual([]);
    expect(
      problems({ type: "pie", version: 1, label: "region", value: "orders" })
    ).toEqual([]);
    expect(
      problems({ type: "table", version: 1, columns: ["paid", "month"] })
    ).toEqual([]);
  });

  it("stat: a missing value, a text value, compare without orderBy", () => {
    expect(problems({ type: "stat", version: 1, value: "gone" })).toEqual([
      { setting: "value", problem: "missing_column" },
    ]);
    expect(problems({ type: "stat", version: 1, value: "region" })).toEqual([
      { setting: "value", problem: "wrong_type" },
    ]);
    expect(
      problems(
        { type: "stat", version: 1, value: "revenue", compare: "next_row" },
        {}
      )
    ).toEqual([{ setting: "compare", problem: "needs_order" }]);
    expect(
      problems(
        { type: "stat", version: 1, value: "revenue", compare: "next_row" },
        { orderBy: [] }
      )
    ).toEqual([{ setting: "compare", problem: "needs_order" }]);
  });

  it.each(["line", "area"] as const)(
    "%s: a missing y, a text y, a text x, a number series",
    (type) => {
      expect(
        problems({ type, version: 1, x: "month", y: ["revenue", "gone"] })
      ).toEqual([{ setting: "y.1", problem: "missing_column" }]);
      expect(problems({ type, version: 1, x: "month", y: ["region"] })).toEqual(
        [{ setting: "y.0", problem: "wrong_type" }]
      );
      expect(
        problems({
          type,
          version: 1,
          x: "region",
          y: ["revenue"],
          series: "orders",
        })
      ).toEqual([
        { setting: "x", problem: "wrong_type" },
        { setting: "series", problem: "wrong_type" },
      ]);
    }
  );

  it("bar: a missing x, a missing y, a text y", () => {
    expect(
      problems({ type: "bar", version: 1, x: "gone", y: ["region"] })
    ).toEqual([
      { setting: "x", problem: "missing_column" },
      { setting: "y.0", problem: "wrong_type" },
    ]);
    expect(
      problems({
        type: "bar",
        version: 1,
        x: "region",
        y: ["gone"],
        series: "gone",
      })
    ).toEqual([
      { setting: "y.0", problem: "missing_column" },
      { setting: "series", problem: "missing_column" },
    ]);
  });

  it("pie: a number label, a text value, a missing value", () => {
    expect(
      problems({ type: "pie", version: 1, label: "revenue", value: "region" })
    ).toEqual([
      { setting: "label", problem: "wrong_type" },
      { setting: "value", problem: "wrong_type" },
    ]);
    expect(
      problems({ type: "pie", version: 1, label: "region", value: "gone" })
    ).toEqual([{ setting: "value", problem: "missing_column" }]);
  });

  it("table: a missing column", () => {
    expect(
      problems({ type: "table", version: 1, columns: ["region", "gone"] })
    ).toEqual([{ setting: "columns.1", problem: "missing_column" }]);
  });
});

describe("gauge", () => {
  const gauge = { type: "gauge", version: 1, value: "revenue", max: "orders" };

  it("accepts value and max, with target, min and unit", () => {
    expect(chartSchema.safeParse(gauge).success).toBe(true);
    expect(
      chartSchema.safeParse({
        ...gauge,
        target: "orders",
        min: 5,
        unit: "USD",
      }).success
    ).toBe(true);
    expect(chartSchema.safeParse({ ...gauge, min: "orders" }).success).toBe(
      true
    );
  });

  it("rejects a missing max", () => {
    expect(
      chartSchema.safeParse({ type: "gauge", version: 1, value: "revenue" })
        .success
    ).toBe(false);
  });

  it("flags a text target, a missing max, a text min", () => {
    const c = { ...gauge, target: "region" } as ChartSettings;
    expect(chartProblems(c, columns, {})).toEqual([
      { setting: "target", problem: "wrong_type" },
    ]);
    expect(
      chartProblems({ ...gauge, max: "gone" } as ChartSettings, columns, {})
    ).toEqual([{ setting: "max", problem: "missing_column" }]);
    expect(
      chartProblems({ ...gauge, min: "region" } as ChartSettings, columns, {})
    ).toEqual([{ setting: "min", problem: "wrong_type" }]);
    expect(
      chartProblems({ ...gauge, min: 3 } as ChartSettings, columns, {})
    ).toEqual([]);
  });
});

describe("DEFAULT_SIZES", () => {
  it("has a size for every type", () => {
    expect(DEFAULT_SIZES).toEqual({
      stat: { w: 3, h: 2 },
      table: { w: 12, h: 4 },
      line: { w: 6, h: 4 },
      area: { w: 6, h: 4 },
      bar: { w: 6, h: 4 },
      pie: { w: 6, h: 4 },
      gauge: { w: 3, h: 3 },
    });
  });
});
