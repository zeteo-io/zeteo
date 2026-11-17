import type { ChartSettings, RunResult } from "../api/types";
import type { EChartsOption } from "echarts";
import type { ChartTheme } from "./theme";

/** A chart shows at most this many series or slices; the rest are folded into "Other". */
export const MAX_SERIES = 20;
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

/** One series per (series value, y column); the 21st onward folded into one "Other". */
function buildSeries(
  chart: Extract<ChartSettings, { x: string }>,
  result: RunResult
): { name: string; points: Point[] }[] {
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
  const out: { name: string; points: Point[] }[] = [];
  keys.slice(0, MAX_SERIES).forEach((key) => {
    chart.y.forEach((y, j) => {
      out.push({
        name: name(key, y),
        points: groups.get(key)!.map((r) => [r[xi], toNumber(r[yis[j]])]),
      });
    });
  });

  const folded = keys.slice(MAX_SERIES);
  if (folded.length > 0) {
    chart.y.forEach((y, j) => {
      const sums = new Map<unknown, number>();
      for (const key of folded)
        for (const r of groups.get(key)!)
          sums.set(r[xi], (sums.get(r[xi]) ?? 0) + (toNumber(r[yis[j]]) ?? 0));
      out.push({
        name: chart.y.length > 1 ? `${OTHER} · ${y}` : OTHER,
        points: [...sums.entries()] as Point[],
      });
    });
  }
  return out;
}

/** The ECharts option for a line, area, bar or pie chart over a result. Pure. */
export function toOption(
  chart: ChartSettings,
  result: RunResult,
  theme: ChartTheme
): EChartsOption {
  if (chart.type === "stat" || chart.type === "table")
    throw new Error(`A ${chart.type} is not drawn by ECharts.`);

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
    const slices = result.rows.map((r) => ({
      name: String(r[li] ?? "(none)"),
      value: toNumber(r[vi]) ?? 0,
    }));
    if (slices.length > MAX_SERIES) {
      const rest = slices.splice(MAX_SERIES);
      slices.push({
        name: OTHER,
        value: rest.reduce((sum, s) => sum + s.value, 0),
      });
    }
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
          data: slices,
          label: { color: theme.text },
        },
      ],
    };
  }

  const xi = indexOfColumn(result, chart.x);
  const xType = result.columns[xi].type;
  const catAxisType =
    xType === "date" || xType === "timestamp"
      ? "time"
      : xType === "number"
        ? "value"
        : "category";
  const horizontal = chart.type === "bar" && chart.horizontal === true;
  const stack =
    (chart.type === "area" || chart.type === "bar") && chart.stacked
      ? "total"
      : undefined;

  const series = buildSeries(chart, result).map((s) => ({
    name: s.name,
    type: chart.type === "bar" ? ("bar" as const) : ("line" as const),
    ...(chart.type === "area" ? { areaStyle: {} } : {}),
    ...(stack ? { stack } : {}),
    ...(chart.type === "bar" ? {} : { showSymbol: false }),
    data: horizontal
      ? s.points.map(([x, y]) => [y, x])
      : s.points.map(([x, y]) => [x, y]),
  }));

  const categoryAxis = {
    type: catAxisType,
    axisLabel: textStyle,
    axisLine: { lineStyle: { color: theme.border } },
  } as const;
  const valueAxis = {
    type: "value",
    axisLabel: { ...textStyle, formatter: (v: number) => fmt(v) },
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
