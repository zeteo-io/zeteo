// Field for field the OpenAPI `Run` schema.

export type RunOutcome = "ok" | "refused" | "failed" | "timeout" | "running";
export type EntryPoint = "api" | "mcp" | "export";

export const RUN_OUTCOMES: RunOutcome[] = [
  "ok",
  "refused",
  "failed",
  "timeout",
  "running",
];

export interface Run {
  id: string;
  user_id: string;
  /** Null when the query named no source the caller could see. */
  source_id: string | null;
  entry_point: EntryPoint;
  /** The query as it was sent; any JSON, or absent. */
  query?: unknown;
  duration_ms: number;
  /** Null unless the run succeeded (and while an export is `running`). */
  row_count: number | null;
  outcome: RunOutcome;
  error_code: string | null;
  truncated: boolean;
  created_at: string;
  /** The saved query the run came from, when it came from one. */
  saved_query?: { id: string; name: string };
}

export interface RunFilters {
  user_id?: string;
  source_id?: string;
  outcome?: RunOutcome;
}
