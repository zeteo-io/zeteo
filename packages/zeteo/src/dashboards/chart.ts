import type { ColumnType } from "../adapters/types.js";
import { z } from "zod";

// A panel's chart settings, our own format (version 1). Every field that
// names a column names a result column: a select item's `as`, else its path.

const columnName = z.string().min(1).max(200);
const decimals = z.int().min(0).max(6).optional();
const legend = z.enum(["auto", "none"]).optional();
const yColumns = z.array(columnName).min(1).max(10);

const statChart = z.strictObject({
  type: z.literal("stat"),
  version: z.literal(1),
  value: columnName,
  compare: z.literal("next_row").optional(),
  unit: z.string().max(20).optional(),
  decimals,
  legend,
});

const lineChart = z.strictObject({
  type: z.literal("line"),
  version: z.literal(1),
  x: columnName,
  y: yColumns,
  series: columnName.optional(),
  decimals,
  legend,
});

const areaChart = z.strictObject({
  type: z.literal("area"),
  version: z.literal(1),
  x: columnName,
  y: yColumns,
  series: columnName.optional(),
  stacked: z.boolean().optional(),
  decimals,
  legend,
});

const barChart = z.strictObject({
  type: z.literal("bar"),
  version: z.literal(1),
  x: columnName,
  y: yColumns,
  series: columnName.optional(),
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  decimals,
  legend,
});

const pieChart = z.strictObject({
  type: z.literal("pie"),
  version: z.literal(1),
  label: columnName,
  value: columnName,
  donut: z.boolean().optional(),
  decimals,
  legend,
});

const tableChart = z.strictObject({
  type: z.literal("table"),
  version: z.literal(1),
  columns: z.array(columnName).min(1).max(50).optional(),
  decimals,
  legend,
});

// Value, target and max name result columns (the first row is read); `min`
// is a column name or a fixed number, 0 when left out.
const gaugeChart = z.strictObject({
  type: z.literal("gauge"),
  version: z.literal(1),
  value: columnName,
  max: columnName,
  target: columnName.optional(),
  min: z.union([columnName, z.number().finite()]).optional(),
  unit: z.string().max(20).optional(),
  decimals,
  legend,
});

export const chartSchema = z.discriminatedUnion("type", [
  statChart,
  lineChart,
  areaChart,
  barChart,
  pieChart,
  tableChart,
  gaugeChart,
]);

export type ChartSettings = z.infer<typeof chartSchema>;
export type ChartType = ChartSettings["type"];

export interface ChartProblem {
  /** The setting at fault: its key, with the index for a list (`y.1`). */
  setting: string;
  problem: "missing_column" | "wrong_type" | "needs_order";
}

/** A new panel's size on the 12-column grid, by chart type. */
export const DEFAULT_SIZES: Record<ChartType, { w: number; h: number }> = {
  stat: { w: 3, h: 2 },
  table: { w: 12, h: 4 },
  line: { w: 6, h: 4 },
  area: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  pie: { w: 6, h: 4 },
  gauge: { w: 3, h: 3 },
};

const NUMBER: readonly ColumnType[] = ["number"];
const TEXT: readonly ColumnType[] = ["text"];
const X_AXIS: readonly ColumnType[] = ["date", "timestamp", "number"];

/**
 * What in `chart` does not fit the result `columns` (from the plan, so
 * nothing runs): a column that is not there, one of the wrong type, or a
 * `compare` on a query with no `orderBy`. Empty when it fits.
 */
export const chartProblems = (
  chart: ChartSettings,
  columns: readonly { name: string; type: ColumnType }[],
  query: { orderBy?: unknown }
): ChartProblem[] => {
  const types = new Map(columns.map((c) => [c.name, c.type]));
  const problems: ChartProblem[] = [];
  const check = (
    setting: string,
    name: string | undefined,
    allowed?: readonly ColumnType[]
  ) => {
    if (name === undefined) return;
    const type = types.get(name);
    if (type === undefined) {
      problems.push({ setting, problem: "missing_column" });
    } else if (allowed && !allowed.includes(type)) {
      problems.push({ setting, problem: "wrong_type" });
    }
  };
  const checkEach = (
    setting: string,
    names: readonly string[] | undefined,
    allowed?: readonly ColumnType[]
  ) => names?.forEach((name, i) => check(`${setting}.${i}`, name, allowed));

  switch (chart.type) {
    case "stat":
      check("value", chart.value, NUMBER);
      if (
        chart.compare !== undefined &&
        !(Array.isArray(query.orderBy) && query.orderBy.length > 0)
      ) {
        problems.push({ setting: "compare", problem: "needs_order" });
      }
      break;
    case "line":
    case "area":
      check("x", chart.x, X_AXIS);
      checkEach("y", chart.y, NUMBER);
      check("series", chart.series, TEXT);
      break;
    case "bar":
      check("x", chart.x);
      checkEach("y", chart.y, NUMBER);
      check("series", chart.series, TEXT);
      break;
    case "pie":
      check("label", chart.label, TEXT);
      check("value", chart.value, NUMBER);
      break;
    case "gauge":
      check("value", chart.value, NUMBER);
      check("max", chart.max, NUMBER);
      check("target", chart.target, NUMBER);
      if (typeof chart.min === "string") check("min", chart.min, NUMBER);
      break;
    case "table":
      checkEach("columns", chart.columns);
      break;
  }
  return problems;
};
