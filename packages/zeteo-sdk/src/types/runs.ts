import type { ListOptions } from "./common.js";

export type RunOutcome = "ok" | "refused" | "failed" | "timeout" | "running";

export interface QueryRun {
  id: string;
  user_id: string;
  /** Null when the query named no source the caller could see. */
  source_id: string | null;
  entry_point: "api" | "mcp" | "export";
  /** The query as it was sent. */
  query: unknown;
  duration_ms: number;
  /** Null unless the run succeeded, and while an export is `running`. */
  row_count: number | null;
  outcome: RunOutcome;
  error_code: string | null;
  truncated: boolean;
  created_at: string;
}

export interface ListRunsOptions extends ListOptions {
  user_id?: string;
  source_id?: string;
  outcome?: RunOutcome;
}
