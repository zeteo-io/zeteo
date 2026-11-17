/** What a panel's chart is drawn from: the saved query's result (the engine's column types). */
export interface RunResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  truncated: boolean;
}

interface ChartBase {
  version: 1;
  legend?: "auto" | "none";
  decimals?: number;
}

export interface StatSettings extends ChartBase {
  type: "stat";
  value: string;
  compare?: "next_row";
  unit?: string;
}
export interface LineSettings extends ChartBase {
  type: "line";
  x: string;
  y: string[];
  series?: string;
}
export interface AreaSettings extends ChartBase {
  type: "area";
  x: string;
  y: string[];
  series?: string;
  stacked?: boolean;
}
export interface BarSettings extends ChartBase {
  type: "bar";
  x: string;
  y: string[];
  series?: string;
  stacked?: boolean;
  horizontal?: boolean;
}
export interface PieSettings extends ChartBase {
  type: "pie";
  label: string;
  value: string;
  donut?: boolean;
}
export interface TableSettings extends ChartBase {
  type: "table";
  columns?: string[];
}

/** The chart settings format, version 1 (the server validates the same shape). */
export type ChartSettings =
  | StatSettings
  | LineSettings
  | AreaSettings
  | BarSettings
  | PieSettings
  | TableSettings;
