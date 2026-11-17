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

export type ChartType = ChartSettings["type"];

/** A result column as the engine types it. */
export interface ResultColumn {
  name: string;
  type: string;
}

/** The range keys a dashboard and a run take (the server's `TIME_RANGE_KEYS`). */
export const TIME_RANGE_KEYS = [
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
] as const;

export type TimeRangeKey = (typeof TIME_RANGE_KEYS)[number];

export type PanelState =
  | "ok"
  | "not_accessible"
  | "saved_query_deleted"
  | "saved_panel_deleted"
  | "not_available"
  | "needs_update";

/** What in a panel's settings does not fit: the setting's key (`y.1` for a list) and why. */
export interface ChartProblem {
  setting: string;
  problem: string;
}

/** A panel as a viewer sees it: settings and ids only when `ok`. */
export interface Panel {
  id: string;
  kind: "own" | "linked";
  x: number;
  y: number;
  w: number;
  h: number;
  title: string | null;
  state: PanelState;
  message?: string;
  chart?: ChartSettings;
  time_column?: string;
  saved_query_id?: string;
  saved_panel_id?: string;
  /** For the panel's editor alone. */
  problems?: ChartProblem[];
}

export type DashboardTheme = "light" | "dark" | "auto";

export interface DashboardSummary {
  id: string;
  name: string;
  description: string;
  owner: { id: string; name: string | null };
  time_range: TimeRangeKey | null;
  refresh_seconds: number | null;
  theme: DashboardTheme;
  created_at: string;
  updated_at: string;
  shared_at?: string;
  share_count?: number;
  url?: string;
}

export interface Dashboard extends DashboardSummary {
  panels: Panel[];
}

export interface SavedPanel {
  id: string;
  name: string;
  description: string;
  owner: { id: string; name: string | null };
  state: PanelState;
  message?: string;
  chart?: ChartSettings;
  time_column?: string;
  saved_query_id?: string;
  problems?: ChartProblem[];
  used_by?: { dashboards: number };
  created_at: string;
  updated_at: string;
  shared_at?: string;
  share_count?: number;
}

/** A dashboard run's result for one panel. */
export interface PanelResult extends RunResult {
  truncated_by?: "rows" | "bytes";
  notice?: string;
}

/** One line of a dashboard run's NDJSON stream. */
export interface PanelLine {
  panel_id: string;
  state: PanelState;
  message?: string;
  result?: PanelResult;
  cached_at?: string;
  error?: { error: string; error_description: string };
}

/** The changes a panel's editor makes to an own panel. */
export interface OwnPanelSettings {
  saved_query_id: string;
  chart: ChartSettings;
  time_column?: string;
}
