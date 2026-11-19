import type { ChartSettings, RunResult } from "../api/types";
import { LIGHT_PALETTE, type ChartTheme } from "./theme";
import type { EChartsOption } from "echarts";

/**
 * A chart shows at most this many series or slices, one per palette colour.
 * Past it the largest MAX_SERIES - 1 keep their own and the rest fold into "Other".
 */
export const MAX_SERIES = LIGHT_PALETTE.length;
const OTHER = "Other";

/** A number with `decimals` places (fixed when set), grouped for reading. */
export function formatNumber(value: unknown, decimals?: number): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString(
    undefined,
    decimals === undefined
      ? undefined
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
  );
}

/**
 * A value axis label: from 10,000 up, compact (5M, 250K), so a long number
 * neither crowds the axis nor runs past the chart's edge; the tooltip keeps
 * the exact value.
 */
export function formatAxisNumber(value: number, decimals?: number): string {
  if (Math.abs(value) < 10_000) return formatNumber(value, decimals);
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function indexOfColumn(result: RunResult, name: string): number {
  const i = result.columns.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`The result has no column "${name}".`);
  return i;
}

const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type Point = [unknown, number | null];

type XAxisType = "time" | "value" | "category";

/** The x axis a column type is drawn on. */
const xAxisTypeOf = (type: string): XAxisType =>
  type === "date" || type === "timestamp"
    ? "time"
    : type === "number"
      ? "value"
      : "category";

/** An x value's place on a time or value axis; null when it has none (drawn last). */
const xPosition = (v: unknown, axis: XAxisType): number | null => {
  if (axis !== "time") return toNumber(v);
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/** The identity of an x value: equal instants or numbers are one x, whatever their spelling. */
const xKeyOf = (v: unknown, axis: XAxisType): string => {
  const at = axis === "category" ? null : xPosition(v, axis);
  return at === null ? `s:${String(v ?? "(none)")}` : `n:${at}`;
};

/** Nulls last; otherwise ascending. */
const byPosition = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

/**
 * The points in order of x on a time or value axis, where a line joins them
 * in the order given; a category axis keeps the rows' order. Stable.
 */
const inOrder = (points: Point[], axis: XAxisType): Point[] => {
  if (axis === "category") return points;
  return points
    .map((p) => ({ p, at: xPosition(p[0], axis) }))
    .sort((a, b) => byPosition(a.at, b.at))
    .map(({ p }) => p);
};

const UTC_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});
const UTC_MINUTE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A date or timestamp as a category label: "May 17, 2026", with the time (UTC) when not midnight. */
export function formatDateLabel(at: number): string {
  return at % 86_400_000 === 0 ? UTC_DAY.format(at) : UTC_MINUTE.format(at);
}

interface BuiltSeries {
  name: string;
  /** Whether this is the folded "Other" series. */
  other: boolean;
  points: Point[];
}

/**
 * One series per (series value, y column), in order of first appearance.
 * Past MAX_SERIES, the MAX_SERIES - 1 largest by total keep their own, largest
 * first, and the rest are summed per x into one "Other", last.
 */
function buildSeries(
  chart: Extract<ChartSettings, { x: string }>,
  result: RunResult,
  axis: XAxisType
): BuiltSeries[] {
  const xi = indexOfColumn(result, chart.x);
  const yis = chart.y.map((y) => indexOfColumn(result, y));
  const si = chart.series ? indexOfColumn(result, chart.series) : -1;

  const keys: string[] = [];
  const groups = new Map<string, unknown[][]>();
  for (const row of result.rows) {
    const key = si < 0 ? "" : String(row[si] ?? "(none)");
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      keys.push(key);
    }
    group.push(row);
  }

  const name = (key: string, y: string) =>
    si < 0 ? y : chart.y.length > 1 ? `${key} · ${y}` : key;
  const all: BuiltSeries[] = [];
  for (const key of keys)
    chart.y.forEach((y, j) => {
      all.push({
        name: name(key, y),
        other: false,
        points: groups.get(key)!.map((r) => [r[xi], toNumber(r[yis[j]])]),
      });
    });

  let out = all;
  if (all.length > MAX_SERIES) {
    const total = (s: BuiltSeries) =>
      s.points.reduce((sum, [, y]) => sum + (y ?? 0), 0);
    const ranked = all
      .map((s) => ({ s, total: total(s) }))
      .sort((a, b) => b.total - a.total)
      .map(({ s }) => s);
    const sums = new Map<string, Point>();
    for (const s of ranked.slice(MAX_SERIES - 1))
      for (const [x, y] of s.points) {
        const k = xKeyOf(x, axis);
        const at = sums.get(k);
        if (at) at[1] = (at[1] ?? 0) + (y ?? 0);
        else sums.set(k, [x, y ?? 0]);
      }
    out = [
      ...ranked.slice(0, MAX_SERIES - 1),
      { name: OTHER, other: true, points: [...sums.values()] },
    ];
  }
  return out.map((s) => ({ ...s, points: inOrder(s.points, axis) }));
}

/**
 * Every series given a value at every x of the union of their x values, so
 * stacks and grouped bars line up by x (ECharts stacks by index). Missing is
 * 0. The union is in order of x on a time or value axis, else of first
 * appearance.
 */
function alignSeries(
  series: BuiltSeries[],
  axis: XAxisType
): {
  xs: { key: string; raw: unknown; at: number | null }[];
  values: number[][];
} {
  const union = new Map<
    string,
    { key: string; raw: unknown; at: number | null; seen: number }
  >();
  for (const s of series)
    for (const [x] of s.points) {
      const key = xKeyOf(x, axis);
      if (!union.has(key))
        union.set(key, {
          key,
          raw: x,
          at: axis === "category" ? null : xPosition(x, axis),
          seen: union.size,
        });
    }
  const xs = [...union.values()].sort((a, b) =>
    axis === "category"
      ? a.seen - b.seen
      : byPosition(a.at, b.at) || a.seen - b.seen
  );
  const index = new Map(xs.map((x, i) => [x.key, i]));
  const values = series.map((s) => {
    const row = xs.map(() => 0);
    for (const [x, y] of s.points) row[index.get(xKeyOf(x, axis))!] += y ?? 0;
    return row;
  });
  return { xs, values };
}

/** A gauge: the first row's value as a progress arc, a pointer at the target. */
function gaugeOption(
  chart: Extract<ChartSettings, { type: "gauge" }>,
  result: RunResult,
  theme: ChartTheme
): EChartsOption {
  const row = result.rows[0];
  if (!row) throw new Error("The result has no rows.");
  const at = (name: string) => toNumber(row[indexOfColumn(result, name)]);
  // Without a value or an end of scale there is nothing to draw: the
  // chart's note says so rather than drawing 0 of 100. A null target only
  // drops the marker.
  const value = at(chart.value);
  const max = at(chart.max);
  if (value === null) throw new Error("No data: the value is empty.");
  if (max === null) throw new Error("No data: the maximum is empty.");
  const target = chart.target === undefined ? null : at(chart.target);
  const min =
    typeof chart.min === "number"
      ? chart.min
      : chart.min
        ? (at(chart.min) ?? 0)
        : 0;
  const fmt = (v: unknown) => formatNumber(v, chart.decimals);
  const scale = {
    min,
    max,
    startAngle: 210,
    endAngle: -30,
    radius: "90%",
    center: ["50%", "62%"],
  };
  const series: unknown[] = [
    {
      ...scale,
      type: "gauge",
      color: theme.palette[0],
      progress: { show: true, width: 14 },
      axisLine: { lineStyle: { width: 14, color: [[1, theme.border]] } },
      pointer: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: theme.textSecondary,
        distance: 22,
        formatter: (v: number) => formatAxisNumber(v, chart.decimals),
      },
      anchor: { show: false },
      title: { show: false },
      detail: {
        valueAnimation: true,
        offsetCenter: [0, "10%"],
        color: theme.text,
        fontSize: 24,
        formatter: (v: number) =>
          chart.unit ? `${fmt(v)} ${chart.unit}` : fmt(v),
      },
      data: [{ value }],
    },
  ];
  if (target !== null)
    series.push({
      ...scale,
      type: "gauge",
      pointer: {
        show: true,
        length: "100%",
        width: 3,
        offsetCenter: [0, 0],
        itemStyle: { color: theme.text },
      },
      progress: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      anchor: { show: false },
      title: { show: false },
      detail: { show: false },
      silent: true,
      data: [{ value: target, name: "Target" }],
    });
  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.text },
    tooltip: {
      valueFormatter: fmt,
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.text },
    },
    series,
  } as EChartsOption;
}

/** The ECharts option for a line, area, bar, pie or gauge chart over a result. Pure. */
export function toOption(
  chart: ChartSettings,
  result: RunResult,
  theme: ChartTheme
): EChartsOption {
  if (chart.type === "stat" || chart.type === "table")
    throw new Error(`A ${chart.type} is not drawn by ECharts.`);
  if (chart.type === "gauge") return gaugeOption(chart, result, theme);

  const fmt = (v: unknown) => formatNumber(v, chart.decimals);
  const textStyle = { color: theme.textSecondary };
  const base = {
    color: theme.palette,
    backgroundColor: "transparent",
    textStyle: { color: theme.text },
    tooltip: {
      trigger: chart.type === "pie" ? "item" : "axis",
      valueFormatter: fmt,
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.text },
    },
  } as const;

  if (chart.type === "pie") {
    const li = indexOfColumn(result, chart.label);
    const vi = indexOfColumn(result, chart.value);
    let slices: { name: string; value: number; other?: true }[] =
      result.rows.map((r) => ({
        name: String(r[li] ?? "(none)"),
        value: toNumber(r[vi]) ?? 0,
      }));
    if (slices.length > MAX_SERIES) {
      const ranked = [...slices].sort((a, b) => b.value - a.value);
      const rest = ranked.slice(MAX_SERIES - 1);
      slices = [
        ...ranked.slice(0, MAX_SERIES - 1),
        {
          name: OTHER,
          value: rest.reduce((sum, s) => sum + s.value, 0),
          other: true,
        },
      ];
    }
    let slot = 0;
    const data = slices.map(({ name, value, other }) => ({
      name,
      value,
      itemStyle: {
        color: other ? theme.textSecondary : theme.palette[slot++],
      },
    }));
    return {
      ...base,
      legend: {
        show: chart.legend !== "none",
        type: "scroll",
        bottom: 0,
        textStyle,
      },
      series: [
        {
          type: "pie",
          radius: chart.donut ? ["45%", "70%"] : "70%",
          center: ["50%", "45%"],
          data,
          label: { color: theme.text },
        },
      ],
    };
  }

  const xi = indexOfColumn(result, chart.x);
  const axis = xAxisTypeOf(result.columns[xi].type);
  const bar = chart.type === "bar";
  const horizontal = bar && chart.horizontal === true;
  const stack =
    (chart.type === "area" || bar) && chart.stacked ? "total" : undefined;

  const built = buildSeries(chart, result, axis);
  let slot = 0;
  const colourOf = (s: BuiltSeries) =>
    s.other ? theme.textSecondary : theme.palette[slot++];
  const styled = built.map((s) => ({ s, color: colourOf(s) }));

  // Bars always sit on a category axis, aligned by x; so do stacked areas
  // (on their own axis), so every stack is summed at the right x.
  const aligned = bar || stack !== undefined;
  const { xs, values } = aligned
    ? alignSeries(built, axis)
    : { xs: [], values: [] };

  const series = styled.map(({ s, color }, i) => ({
    name: s.name,
    type: bar ? ("bar" as const) : ("line" as const),
    color,
    ...(chart.type === "area" ? { areaStyle: {} } : {}),
    ...(stack ? { stack } : {}),
    ...(bar
      ? stack
        ? { itemStyle: { borderColor: theme.background, borderWidth: 1 } }
        : {}
      : { showSymbol: false }),
    data: bar
      ? values[i]
      : aligned
        ? xs.map((x, j) => [x.raw, values[i][j]])
        : s.points.map(([x, y]) => [x, y]),
  }));

  const label = (x: { raw: unknown; at: number | null }) =>
    axis === "time" && x.at !== null
      ? formatDateLabel(x.at)
      : String(x.raw ?? "(none)");
  const categoryAxis = {
    type: bar ? "category" : axis,
    ...(bar && { data: xs.map(label) }),
    axisLabel: textStyle,
    axisLine: { lineStyle: { color: theme.border } },
    // ECharts draws a y category axis from the bottom; rows read top-down.
    ...(horizontal && { inverse: true }),
  } as const;
  const valueAxis = {
    type: "value",
    axisLabel: {
      ...textStyle,
      formatter: (v: number) => formatAxisNumber(v, chart.decimals),
    },
    splitLine: { lineStyle: { color: theme.border } },
  } as const;

  return {
    ...base,
    grid: { left: 12, right: 16, top: 16, bottom: 36, containLabel: true },
    legend: {
      show: chart.legend !== "none" && series.length > 1,
      type: "scroll",
      bottom: 0,
      textStyle,
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
  } as EChartsOption;
}
