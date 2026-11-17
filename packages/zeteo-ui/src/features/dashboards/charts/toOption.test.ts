import { MAX_SERIES, toOption } from "./toOption";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../api/types";
import type { ChartTheme } from "./theme";

const theme: ChartTheme = {
  palette: ["#a", "#b", "#c"],
  text: "#000",
  textSecondary: "#555",
  border: "#ddd",
  background: "#fff",
};

const result = (columns: [string, string][], rows: unknown[][]): RunResult => ({
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  truncated: false,
});

// The option's pieces are read as plain data here.
/* eslint-disable @typescript-eslint/no-explicit-any */
const opt = (o: unknown): any => o;

describe("toOption", () => {
  const sales = result(
    [
      ["month", "text"],
      ["region", "text"],
      ["revenue", "number"],
      ["cost", "number"],
    ],
    [
      ["jan", "eu", 10, 1],
      ["jan", "us", 20, 2],
      ["feb", "eu", 30, 3],
      ["feb", "us", 40, 4],
    ]
  );

  it("draws one series per y column", () => {
    const o = opt(
      toOption(
        { version: 1, type: "line", x: "month", y: ["revenue", "cost"] },
        sales,
        theme
      )
    );
    expect(o.series.map((s: any) => s.name)).toEqual(["revenue", "cost"]);
    expect(o.series[0].type).toBe("line");
    expect(o.series[0].data).toEqual([
      ["jan", 10],
      ["jan", 20],
      ["feb", 30],
      ["feb", 40],
    ]);
    expect(o.xAxis.type).toBe("category");
    expect(o.color).toEqual(theme.palette);
  });

  it("splits rows into one series per distinct value of the series column", () => {
    const o = opt(
      toOption(
        {
          version: 1,
          type: "line",
          x: "month",
          y: ["revenue"],
          series: "region",
        },
        sales,
        theme
      )
    );
    expect(o.series.map((s: any) => s.name)).toEqual(["eu", "us"]);
    expect(o.series[1].data).toEqual([
      ["jan", 20],
      ["feb", 40],
    ]);
  });

  it("names series 'series · column' when several y columns are split", () => {
    const o = opt(
      toOption(
        {
          version: 1,
          type: "bar",
          x: "month",
          y: ["revenue", "cost"],
          series: "region",
        },
        sales,
        theme
      )
    );
    expect(o.series.map((s: any) => s.name)).toEqual([
      "eu · revenue",
      "eu · cost",
      "us · revenue",
      "us · cost",
    ]);
  });

  it("makes an area a line with an areaStyle", () => {
    const o = opt(
      toOption(
        { version: 1, type: "area", x: "month", y: ["revenue"] },
        sales,
        theme
      )
    );
    expect(o.series[0].type).toBe("line");
    expect(o.series[0].areaStyle).toBeDefined();
    expect(o.series[0].stack).toBeUndefined();
  });

  it("stacks every series under one stack id", () => {
    const o = opt(
      toOption(
        {
          version: 1,
          type: "area",
          x: "month",
          y: ["revenue", "cost"],
          stacked: true,
        },
        sales,
        theme
      )
    );
    const ids = new Set(o.series.map((s: any) => s.stack));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it("stacks bars", () => {
    const o = opt(
      toOption(
        {
          version: 1,
          type: "bar",
          x: "month",
          y: ["revenue", "cost"],
          stacked: true,
        },
        sales,
        theme
      )
    );
    expect(o.series[0].type).toBe("bar");
    expect(o.series[0].stack).toBe(o.series[1].stack);
    expect(o.series[0].stack).toBeTruthy();
  });

  it("swaps the axes of a horizontal bar chart", () => {
    const o = opt(
      toOption(
        {
          version: 1,
          type: "bar",
          x: "month",
          y: ["revenue"],
          horizontal: true,
        },
        sales,
        theme
      )
    );
    expect(o.yAxis.type).toBe("category");
    expect(o.xAxis.type).toBe("value");
    expect(o.series[0].data[0]).toEqual([10, "jan"]);
  });

  it("uses a time axis for a date or timestamp x", () => {
    for (const type of ["date", "timestamp"]) {
      const r = result(
        [
          ["day", type],
          ["n", "number"],
        ],
        [
          ["2026-01-01", 1],
          ["2026-01-02", 2],
        ]
      );
      const o = opt(
        toOption({ version: 1, type: "line", x: "day", y: ["n"] }, r, theme)
      );
      expect(o.xAxis.type).toBe("time");
    }
  });

  it("uses a value axis for a number x", () => {
    const r = result(
      [
        ["n", "number"],
        ["m", "number"],
      ],
      [[1, 2]]
    );
    const o = opt(
      toOption({ version: 1, type: "line", x: "n", y: ["m"] }, r, theme)
    );
    expect(o.xAxis.type).toBe("value");
  });

  it("draws a line over a time x in order of x, whatever the rows' order", () => {
    const r = result(
      [
        ["day", "timestamp"],
        ["region", "text"],
        ["n", "number"],
      ],
      [
        ["2026-01-03T00:00:00Z", "eu", 3],
        ["2026-01-01T00:00:00Z", "eu", 1],
        ["2026-01-02T00:00:00Z", "us", 20],
        ["2026-01-02T00:00:00Z", "eu", 2],
        ["2026-01-01T00:00:00Z", "us", 10],
      ]
    );
    const o = opt(
      toOption(
        { version: 1, type: "area", x: "day", y: ["n"], series: "region" },
        r,
        theme
      )
    );
    expect(o.series[0].data).toEqual([
      ["2026-01-01T00:00:00Z", 1],
      ["2026-01-02T00:00:00Z", 2],
      ["2026-01-03T00:00:00Z", 3],
    ]);
    expect(o.series[1].data).toEqual([
      ["2026-01-01T00:00:00Z", 10],
      ["2026-01-02T00:00:00Z", 20],
    ]);
  });

  it("draws a line over a number x in numeric order", () => {
    const r = result(
      [
        ["n", "number"],
        ["m", "number"],
      ],
      [
        [10, 1],
        [2, 2],
        ["9", 3],
      ]
    );
    const o = opt(
      toOption({ version: 1, type: "line", x: "n", y: ["m"] }, r, theme)
    );
    expect(o.series[0].data).toEqual([
      [2, 2],
      ["9", 3],
      [10, 1],
    ]);
  });

  it("orders the folded Other series by x on a time axis", () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 20; i++) rows.push(["2026-01-01", `s${i}`, 1]);
    rows.push(["2026-01-03", "s20", 5]);
    rows.push(["2026-01-01", "s21", 7]);
    rows.push(["2026-01-02", "s22", 6]);
    const r = result(
      [
        ["day", "date"],
        ["region", "text"],
        ["n", "number"],
      ],
      rows
    );
    const o = opt(
      toOption(
        { version: 1, type: "line", x: "day", y: ["n"], series: "region" },
        r,
        theme
      )
    );
    expect(o.series[20].name).toBe("Other");
    expect(o.series[20].data).toEqual([
      ["2026-01-01", 7],
      ["2026-01-02", 6],
      ["2026-01-03", 5],
    ]);
  });

  it("keeps a category x in the rows' order", () => {
    const r = result(
      [
        ["month", "text"],
        ["n", "number"],
      ],
      [
        ["mar", 3],
        ["jan", 1],
      ]
    );
    const o = opt(
      toOption({ version: 1, type: "line", x: "month", y: ["n"] }, r, theme)
    );
    expect(o.series[0].data).toEqual([
      ["mar", 3],
      ["jan", 1],
    ]);
  });

  it("folds series beyond the twentieth into Other, summing them", () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 23; i++) rows.push(["jan", `s${i}`, 1]);
    const r = result(
      [
        ["month", "text"],
        ["region", "text"],
        ["revenue", "number"],
      ],
      rows
    );
    const o = opt(
      toOption(
        {
          version: 1,
          type: "bar",
          x: "month",
          y: ["revenue"],
          series: "region",
        },
        r,
        theme
      )
    );
    expect(MAX_SERIES).toBe(20);
    expect(o.series).toHaveLength(21);
    const other = o.series[20];
    expect(other.name).toBe("Other");
    expect(other.data).toEqual([["jan", 3]]);
  });

  it("formats numbers in the tooltip and the axis with decimals", () => {
    const o = opt(
      toOption(
        {
          version: 1,
          type: "line",
          x: "month",
          y: ["revenue"],
          decimals: 1,
        },
        sales,
        theme
      )
    );
    expect(o.yAxis.axisLabel.formatter(2)).toBe("2.0");
    expect(o.tooltip.valueFormatter(1234.5678)).toBe(
      (1234.5678).toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    );
  });

  it("hides the legend for legend none and for one series", () => {
    const base = { version: 1, type: "line", x: "month" } as const;
    expect(
      opt(toOption({ ...base, y: ["revenue", "cost"] }, sales, theme)).legend
        .show
    ).toBe(true);
    expect(
      opt(
        toOption(
          { ...base, y: ["revenue", "cost"], legend: "none" },
          sales,
          theme
        )
      ).legend.show
    ).toBe(false);
    expect(
      opt(toOption({ ...base, y: ["revenue"] }, sales, theme)).legend.show
    ).toBe(false);
  });

  it("draws a pie with one slice per row, and a donut with an inner radius", () => {
    const r = result(
      [
        ["region", "text"],
        ["revenue", "number"],
      ],
      [
        ["eu", 10],
        ["us", 20],
      ]
    );
    const pie = opt(
      toOption(
        { version: 1, type: "pie", label: "region", value: "revenue" },
        r,
        theme
      )
    );
    expect(pie.series[0].type).toBe("pie");
    expect(pie.series[0].data).toEqual([
      { name: "eu", value: 10 },
      { name: "us", value: 20 },
    ]);
    expect(pie.series[0].radius).toBe("70%");
    const donut = opt(
      toOption(
        {
          version: 1,
          type: "pie",
          label: "region",
          value: "revenue",
          donut: true,
        },
        r,
        theme
      )
    );
    expect(donut.series[0].radius).toEqual(["45%", "70%"]);
  });

  it("folds pie slices beyond the twentieth into Other", () => {
    const rows = Array.from({ length: 22 }, (_, i) => [`s${i}`, 1]);
    const r = result(
      [
        ["l", "text"],
        ["v", "number"],
      ],
      rows
    );
    const o = opt(
      toOption({ version: 1, type: "pie", label: "l", value: "v" }, r, theme)
    );
    expect(o.series[0].data).toHaveLength(21);
    expect(o.series[0].data[20]).toEqual({ name: "Other", value: 2 });
  });

  it("throws for a column the result lacks", () => {
    expect(() =>
      toOption(
        { version: 1, type: "line", x: "nope", y: ["revenue"] },
        sales,
        theme
      )
    ).toThrow(/nope/);
  });
});
