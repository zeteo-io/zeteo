import { formatAxisNumber, MAX_SERIES, toOption } from "./toOption";
import type { ChartSettings, RunResult } from "../api/types";
import { DARK_PALETTE, LIGHT_PALETTE } from "./theme";
import { describe, expect, it } from "vitest";
import type { ChartTheme } from "./theme";

const theme: ChartTheme = {
  palette: LIGHT_PALETTE,
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
    expect(o.yAxis.data).toEqual(["jan", "feb"]);
    expect(o.series[0].data).toEqual([30, 70]);
    // The first row is at the top.
    expect(o.yAxis.inverse).toBe(true);
  });

  it("does not invert the category axis of a vertical bar chart", () => {
    const o = opt(
      toOption(
        { version: 1, type: "bar", x: "month", y: ["revenue"] },
        sales,
        theme
      )
    );
    expect(o.xAxis.inverse).toBeUndefined();
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
      { name: "eu", value: 10, itemStyle: { color: LIGHT_PALETTE[0] } },
      { name: "us", value: 20, itemStyle: { color: LIGHT_PALETTE[1] } },
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

  describe("colours", () => {
    const split = (n: number) =>
      result(
        [
          ["month", "text"],
          ["who", "text"],
          ["v", "number"],
        ],
        Array.from({ length: n }, (_, i) => ["jan", `s${i}`, i + 1])
      );
    const bars: ChartSettings = {
      version: 1,
      type: "bar",
      x: "month",
      y: ["v"],
      series: "who",
    };

    it("gives series 1-9 the palette's colours in order, none twice", () => {
      const o = opt(toOption(bars, split(9), theme));
      const colours = o.series.map((s: any) => s.color);
      expect(colours).toEqual(LIGHT_PALETTE);
      expect(new Set(colours).size).toBe(9);
      expect(o.series.map((s: any) => s.name)).toEqual(
        Array.from({ length: 9 }, (_, i) => `s${i}`)
      );
    });

    it("takes the dark colours from a dark theme", () => {
      const o = opt(
        toOption(bars, split(9), { ...theme, palette: DARK_PALETTE })
      );
      expect(o.series.map((s: any) => s.color)).toEqual(DARK_PALETTE);
    });

    it("uses ECharts' default palettes, nine distinct colours per theme", () => {
      expect(LIGHT_PALETTE[0]).toBe("#5470c6");
      expect(DARK_PALETTE[0]).toBe("#4992ff");
      expect(new Set(LIGHT_PALETTE).size).toBe(9);
      expect(new Set(DARK_PALETTE).size).toBe(9);
    });
  });

  it("keeps the eight largest of eleven series and sums the rest into a grey Other, per x", () => {
    // Totals: s0..s10 = 1..11 per month, two months; s0..s2 fold.
    const rows: unknown[][] = [];
    for (const month of ["jan", "feb"])
      for (let i = 0; i < 11; i++) rows.push([month, `s${i}`, i + 1]);
    // s0 has no feb row: Other is 2+3 in feb.
    rows.splice(11, 1);
    const r = result(
      [
        ["month", "text"],
        ["who", "text"],
        ["v", "number"],
      ],
      rows
    );
    const o = opt(
      toOption(
        { version: 1, type: "line", x: "month", y: ["v"], series: "who" },
        r,
        theme
      )
    );
    expect(MAX_SERIES).toBe(9);
    expect(o.series.map((s: any) => s.name)).toEqual([
      "s10",
      "s9",
      "s8",
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
      "Other",
    ]);
    expect(o.series.slice(0, 8).map((s: any) => s.color)).toEqual(
      LIGHT_PALETTE.slice(0, 8)
    );
    expect(o.series[8].color).toBe(theme.textSecondary);
    expect(o.series[8].data).toEqual([
      ["jan", 1 + 2 + 3],
      ["feb", 2 + 3],
    ]);
  });

  it("folds a pie of ten slices into the eight largest and Other", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`s${i}`, i + 1]);
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
    const data = o.series[0].data;
    expect(data.map((d: any) => d.name)).toEqual([
      "s9",
      "s8",
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
      "s2",
      "Other",
    ]);
    expect(data[8].value).toBe(1 + 2);
    expect(data[8].itemStyle.color).toBe(theme.textSecondary);
    expect(data.slice(0, 8).map((d: any) => d.itemStyle.color)).toEqual(
      LIGHT_PALETTE.slice(0, 8)
    );
  });

  describe("stacking by x", () => {
    // Weeks out of order, and pickers with weeks missing.
    const picks = result(
      [
        ["week", "timestamp"],
        ["picker", "text"],
        ["picks", "number"],
      ],
      [
        ["2026-05-18T00:00:00.000Z", "ann", 5],
        ["2026-05-04T00:00:00.000Z", "ann", 1],
        ["2026-05-11T00:00:00.000Z", "bob", 7],
        ["2026-05-18T00:00:00.000Z", "cy", 2],
        ["2026-05-04T00:00:00.000Z", "cy", 3],
      ]
    );

    it("gives every stacked bar series a value at every x, 0 when missing, in order of x", () => {
      const o = opt(
        toOption(
          {
            version: 1,
            type: "bar",
            x: "week",
            y: ["picks"],
            series: "picker",
            stacked: true,
          },
          picks,
          theme
        )
      );
      expect(o.xAxis.type).toBe("category");
      expect(o.xAxis.data).toEqual([
        "May 4, 2026",
        "May 11, 2026",
        "May 18, 2026",
      ]);
      expect(o.series.map((s: any) => s.data)).toEqual([
        [1, 0, 5],
        [0, 7, 0],
        [3, 0, 2],
      ]);
      const totals = [0, 1, 2].map((i) =>
        o.series.reduce((sum: number, s: any) => sum + s.data[i], 0)
      );
      expect(totals).toEqual([4, 7, 7]);
      expect(o.series[0].itemStyle).toEqual({
        borderColor: theme.background,
        borderWidth: 1,
      });
    });

    it("aligns unstacked bars with a series split, without separators", () => {
      const o = opt(
        toOption(
          {
            version: 1,
            type: "bar",
            x: "week",
            y: ["picks"],
            series: "picker",
          },
          picks,
          theme
        )
      );
      expect(o.series[1].data).toEqual([0, 7, 0]);
      expect(o.series[0].stack).toBeUndefined();
      expect(o.series[0].itemStyle).toBeUndefined();
    });

    it("gives every stacked area series a point at every x on a time axis", () => {
      const o = opt(
        toOption(
          {
            version: 1,
            type: "area",
            x: "week",
            y: ["picks"],
            series: "picker",
            stacked: true,
          },
          picks,
          theme
        )
      );
      expect(o.xAxis.type).toBe("time");
      expect(o.series[1].data).toEqual([
        ["2026-05-04T00:00:00.000Z", 0],
        ["2026-05-11T00:00:00.000Z", 7],
        ["2026-05-18T00:00:00.000Z", 0],
      ]);
    });

    it("leaves gaps in unstacked lines", () => {
      const o = opt(
        toOption(
          {
            version: 1,
            type: "line",
            x: "week",
            y: ["picks"],
            series: "picker",
          },
          picks,
          theme
        )
      );
      expect(o.xAxis.type).toBe("time");
      expect(o.series[1].data).toEqual([["2026-05-11T00:00:00.000Z", 7]]);
    });
  });

  it("draws bars over a date x on a category axis with dates as labels, in order", () => {
    const r = result(
      [
        ["day", "date"],
        ["n", "number"],
      ],
      [
        ["2026-06-01", 2],
        ["2026-05-17", 1],
      ]
    );
    const o = opt(
      toOption({ version: 1, type: "bar", x: "day", y: ["n"] }, r, theme)
    );
    expect(o.xAxis.type).toBe("category");
    expect(o.xAxis.data).toEqual(["May 17, 2026", "Jun 1, 2026"]);
    expect(o.series[0].data).toEqual([1, 2]);
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

describe("formatAxisNumber", () => {
  const compact = (n: number) =>
    new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);

  it("shortens values from 10,000 up, so the last label fits the chart", () => {
    expect(formatAxisNumber(5_000_000)).toBe(compact(5_000_000));
    expect(formatAxisNumber(250_000, 2)).toBe(compact(250_000));
    expect(formatAxisNumber(-12_500)).toBe(compact(-12_500));
  });

  it("keeps smaller values as they are, with their decimals", () => {
    expect(formatAxisNumber(9_999)).toBe((9_999).toLocaleString());
    expect(formatAxisNumber(2, 1)).toBe("2.0");
  });
});
