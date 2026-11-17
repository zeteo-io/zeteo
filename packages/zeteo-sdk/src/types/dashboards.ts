import type { ColumnType, ListOptions } from "./common.js";
import type {
  SavedQueryShare,
  SavedQueryShares,
  SharePrincipal,
} from "./savedQueries.js";

/**
 * A named time range for a dashboard, applied to each panel's time column as
 * `>= start` and `< end`. The `last_*` ranges run from that long before now to
 * the start of the next minute; the others are the calendar day, week
 * (starting Monday), month, quarter or year, in UTC.
 */
export type TimeRangeKey =
  | "last_15_minutes"
  | "last_hour"
  | "last_6_hours"
  | "last_24_hours"
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "last_6_months"
  | "last_year"
  | "last_2_years"
  | "today"
  | "this_week"
  | "this_month"
  | "this_quarter"
  | "this_year"
  | "previous_week"
  | "previous_month"
  | "previous_quarter"
  | "previous_year";

export type DashboardTheme = "light" | "dark" | "auto";

/**
 * Every field that names a column names a column of the saved query's result:
 * a select item's `as`, else its path.
 */
interface ChartCommon {
  version: 1;
  /** Decimal places shown, 0 to 6. */
  decimals?: number;
  legend?: "auto" | "none";
}

export interface StatChart extends ChartCommon {
  type: "stat";
  /** A number column. */
  value: string;
  /** Compare with the next row; the saved query then needs an `orderBy`. */
  compare?: "next_row";
  /** At most 20 characters. */
  unit?: string;
}

export interface LineChart extends ChartCommon {
  type: "line";
  /** A date, timestamp or number column. */
  x: string;
  /** 1 to 10 number columns. */
  y: string[];
  /** A text column. */
  series?: string;
}

export interface AreaChart extends ChartCommon {
  type: "area";
  /** A date, timestamp or number column. */
  x: string;
  /** 1 to 10 number columns. */
  y: string[];
  /** A text column. */
  series?: string;
  stacked?: boolean;
}

export interface BarChart extends ChartCommon {
  type: "bar";
  x: string;
  /** 1 to 10 number columns. */
  y: string[];
  /** A text column. */
  series?: string;
  stacked?: boolean;
  horizontal?: boolean;
}

export interface PieChart extends ChartCommon {
  type: "pie";
  /** A text column. */
  label: string;
  /** A number column. */
  value: string;
  donut?: boolean;
}

export interface TableChart extends ChartCommon {
  type: "table";
  /** 1 to 50 columns, in order; all of them when left out. */
  columns?: string[];
}

/** A panel's chart; narrow on `type`. */
export type ChartSettings =
  StatChart | LineChart | AreaChart | BarChart | PieChart | TableChart;

/**
 * What the viewer can do with a panel. `ok`: it can run. `not_accessible`:
 * not granted what the saved query reads (never told why). `*_deleted`: what
 * it was built on is gone. `not_available`: its saved query is no longer
 * available for dashboards, or its saved panel no longer shared. `needs_update`:
 * its chart no longer fits the saved query's result; its owner must change it.
 */
export type PanelState =
  | "ok"
  | "not_accessible"
  | "saved_query_deleted"
  | "saved_panel_deleted"
  | "not_available"
  | "needs_update";

export interface ChartProblem {
  /** The setting at fault: its key, with the index for a list (`y.1`). */
  setting: string;
  /** `missing_column`, `wrong_type` or `needs_order`; for a saved query or panel that cannot be used, its state. */
  problem: string;
}

/**
 * A panel as the viewer sees it. `chart`, `time_column`, `saved_query_id` and
 * `saved_panel_id` are present only when `state` is `ok` (never null).
 */
export interface Panel {
  id: string;
  kind: "own" | "linked";
  /** Column on a grid of 12. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its own title, else its saved panel's or saved query's name; null when none is left. */
  title: string | null;
  state: PanelState;
  /** What the viewer is told when the state is not `ok`. */
  message?: string;
  chart?: ChartSettings;
  time_column?: string;
  saved_query_id?: string;
  saved_panel_id?: string;
  /** For `needs_update`, and only for the panel's editor. */
  problems?: ChartProblem[];
}

/** A panel's place on the grid. `x` and `y` go together, and `x + w` is at most 12. */
export interface PanelPlace {
  /** 0 to 11. */
  x?: number;
  /** 0 to 1000. */
  y?: number;
  /** 1 to 12. */
  w?: number;
  /** 1 to 50. */
  h?: number;
}

/** A new panel with its own saved query, chart and time column. */
export interface OwnPanelInput extends PanelPlace {
  kind: "own";
  saved_query_id: string;
  chart: ChartSettings;
  /** A date or timestamp column of the saved query's result. */
  time_column?: string;
  /** 1 to 100 characters. */
  title?: string;
}

/** A new panel linked to a saved panel. */
export interface LinkedPanelInput extends PanelPlace {
  kind: "linked";
  saved_panel_id: string;
  title?: string;
}

export type PanelInput = OwnPanelInput | LinkedPanelInput;

/** A panel kept by `update`'s list, with its place and optionally new own settings. */
export interface ExistingPanelInput extends PanelPlace {
  id: string;
  /** Null removes the panel's own title. */
  title?: string | null;
  saved_query_id?: string;
  chart?: ChartSettings;
  /** Null removes the time column. */
  time_column?: string | null;
}

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
  /** When it was first shared with the viewer; present only when it was. */
  shared_at?: string;
  /** Present only when the viewer may see the share list. */
  share_count?: number;
  /** Where the admin UI shows it; present only when the admin UI is served. */
  url?: string;
}

export interface Dashboard extends DashboardSummary {
  panels: Panel[];
}

export interface ListDashboardsOptions extends ListOptions {
  /** `mine` (the default), `shared` with the caller, or `all` (`zeteo.dashboards.read`). */
  scope?: "mine" | "shared" | "all";
  /** 1 to 100 characters of the name, case-insensitively. */
  q?: string;
  /** `scope: "all"` only. */
  owner_id?: string;
}

export interface CreateDashboardRequest {
  /** 1 to 100 characters, trimmed; unique per owner, whatever the case. */
  name: string;
  /** At most 2000 characters; the API's default is `""`. */
  description?: string;
  time_range?: TimeRangeKey | null;
  /** At least the deploy's `DASHBOARD_MIN_REFRESH_SECONDS` (default 60), at most 86400. */
  refresh_seconds?: number | null;
  theme?: DashboardTheme;
  /** At most 50. */
  panels?: PanelInput[];
}

/** At least one field. */
export interface UpdateDashboardRequest {
  name?: string;
  description?: string;
  time_range?: TimeRangeKey | null;
  refresh_seconds?: number | null;
  theme?: DashboardTheme;
  /**
   * The whole list: a panel with an `id` is kept (and changed as given), one
   * without is added, and one of the dashboard not listed is removed.
   */
  panels?: (ExistingPanelInput | PanelInput)[];
}

/** At least one field; the settings are for an own panel only. */
export interface UpdatePanelRequest extends PanelPlace {
  /** Null removes the panel's own title. */
  title?: string | null;
  saved_query_id?: string;
  chart?: ChartSettings;
  /** Null removes the time column. */
  time_column?: string | null;
}

export interface CopyDashboardRequest {
  name: string;
}

export interface TransferOwnerRequest {
  user_id: string;
  /** The previous owner keeps a direct share; the API's default is true. */
  keep_access?: boolean;
}

export type DashboardShare = SavedQueryShare;
export type DashboardShares = SavedQueryShares;
export type { SharePrincipal };

export interface RunDashboardOptions {
  /** Run only these panels (1 to 100 ids, each once); an id not on the dashboard is ignored. */
  panels?: string[];
  /** The range for this run; null for none; left out for the dashboard's own. */
  time_range?: TimeRangeKey | null;
  signal?: AbortSignal;
}

/**
 * One panel's line of a dashboard's run, in the order panels are ready. Never
 * its chart or its query. `result` only for an `ok` panel that ran; `error`
 * for an `ok` panel whose run failed.
 */
export interface PanelLine {
  panel_id: string;
  state: PanelState;
  message?: string;
  result?: {
    columns: { name: string; type: ColumnType }[];
    /** In the wire forms of `query.run`. */
    rows: unknown[][];
    truncated: boolean;
    truncated_by?: "rows" | "bytes";
    /** When rows were left out for the row cap: what the viewer is told. */
    notice?: string;
  };
  /** When the result came from the cache: when it was read from the source. */
  cached_at?: string;
  error?: { error: string; error_description: string };
}
