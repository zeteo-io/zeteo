import type { ListOptions } from "./common.js";

export type RunOutcome = "ok" | "refused" | "failed" | "timeout" | "running";

export interface QueryRun {
  id: string;
  user_id: string;
  /** Null when the query named no source the caller could see. */
  source_id: string | null;
  entry_point: "api" | "mcp" | "export" | "dashboard" | "measure_preview";
  /**
   * The query as it was sent; `{ withheld: true }` in `me.runs` for a run of a
   * saved query the caller cannot open (such as a panel of someone else's
   * dashboard) and for a refused saved query run.
   */
  query: unknown;
  duration_ms: number;
  /** Null unless the run succeeded, and while an export is `running`. */
  row_count: number | null;
  outcome: RunOutcome;
  error_code: string | null;
  truncated: boolean;
  created_at: string;
  /**
   * The saved query the run was of. `me.runs` names it only while the viewer
   * owns it or it is shared with them; `runs.list` (admin) always names it. A
   * refused saved query run has `query` as `{ withheld: true }` and `source_id`
   * null.
   */
  saved_query?: { id: string; name: string };
}

export interface ListRunsOptions extends ListOptions {
  user_id?: string;
  source_id?: string;
  /** Only the runs of this saved query. */
  saved_query_id?: string;
  outcome?: RunOutcome;
}

/** The caller's own runs: the filters of `ListRunsOptions` without the user and source. */
export type ListMyRunsOptions = Omit<ListRunsOptions, "user_id" | "source_id">;
