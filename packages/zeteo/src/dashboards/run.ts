import { AppError, SavedQueryNotAccessibleError } from "../utils/errors.js";
import { decidePanels, PANEL_MESSAGES, type OkDecision } from "./decide.js";
import type { DashboardWithPanels } from "../utils/db/dashboards.js";
import { floorToMinute } from "../adapters/sql/relative.js";
import { loadUserLimits } from "../limits/resolve.js";
import { groupIdsOf } from "../grants/principals.js";
import type { Caller } from "../middleware/auth.js";
import type { PanelState } from "./decide.js";
import { logger } from "../utils/logger.js";
import env from "../env.js";
import {
  recordDashboardRefusal,
  runQuery,
  type DashboardRunResult,
} from "../engine/index.js";
import {
  TIME_RANGE_KEYS,
  withTimeFilter,
  type TimeRangeKey,
} from "./timeRange.js";

/** One panel's line of a dashboard's run. Never its chart or its query. */
export interface PanelLine {
  panel_id: string;
  state: PanelState;
  message?: string;
  /** Only for an `ok` panel that ran. */
  result?: {
    columns: DashboardRunResult["columns"];
    rows: unknown[][];
    truncated: boolean;
    truncated_by?: "rows" | "bytes";
    /** When rows were left out for the row cap: what the viewer is told. */
    notice?: string;
  };
  /** When the result came from the cache. */
  cached_at?: string;
  /** An `ok` panel whose run failed. */
  error?: { error: string; error_description: string };
}

/** The last line of a dashboard's run. */
export const DONE_LINE = { done: true } as const;

export interface RunDashboardOptions {
  /** Only these panels; the dashboard's others are left out (and an id not on it ignored). */
  panels?: string[];
  /** The range for this run; null for none, absent for the dashboard's own. */
  timeRange?: TimeRangeKey | null;
}

/** What a viewer is told of a result cut at the row cap. */
export const truncatedNotice = (rows: number): string =>
  `Showing the first ${rows.toLocaleString("en-US")} rows; aggregate the saved query to see everything.`;

const isTimeRangeKey = (value: string | null): value is TimeRangeKey =>
  value !== null && (TIME_RANGE_KEYS as readonly string[]).includes(value);

/** The panels whose runs are the same query: one run, every panel's line. */
interface RunGroup {
  decision: OkDecision;
  /** The time column the run filters on, when a range is applied. */
  timeColumn?: string;
  panelIds: string[];
}

const resultOf = (r: DashboardRunResult): PanelLine["result"] => ({
  columns: r.columns,
  rows: r.rows,
  truncated: r.truncated,
  ...(r.truncated_by && { truncated_by: r.truncated_by }),
  ...(r.truncated_by === "rows" && { notice: truncatedNotice(r.rows.length) }),
});

/**
 * Runs a dashboard's panels as `caller` and emits a line per panel as soon
 * as it is ready, then the done line. Every panel is decided first; one that
 * is not `ok` is emitted at once and never run (a `not_accessible` one is
 * recorded as a refusal). The `ok` panels run as the dashboard entry point
 * against one `now`, the panels whose queries are the same (saved query,
 * time column and range) run once, and at most the lower of the caller's
 * query concurrency and `DASHBOARD_PARALLELISM` run at a time; the rest wait
 * their turn. A refusal at run time is the same `not_accessible` line;
 * another failure is the panel's `error`. Rejects only when `signal` aborts
 * or a line cannot be written.
 */
export const runDashboard = async (
  caller: Caller,
  dashboard: DashboardWithPanels,
  opts: RunDashboardOptions,
  emit: (line: PanelLine | typeof DONE_LINE) => Promise<void>,
  signal: AbortSignal
): Promise<void> => {
  const timeRange =
    opts.timeRange !== undefined
      ? opts.timeRange
      : isTimeRangeKey(dashboard.timeRange)
        ? dashboard.timeRange
        : null;
  const wanted = opts.panels && new Set(opts.panels);
  const panels = wanted
    ? dashboard.panels.filter((p) => wanted.has(p.id))
    : dashboard.panels;
  const decisions = await decidePanels(
    caller,
    { ...dashboard, panels },
    timeRange
  );
  const now = floorToMinute(new Date());
  const ref = { dashboardId: dashboard.id };

  const groups = new Map<string, RunGroup>();
  const refusals: Promise<void>[] = [];
  for (const panel of panels) {
    const decision = decisions.get(panel.id)!;
    if (decision.state !== "ok") {
      await emit({
        panel_id: panel.id,
        state: decision.state,
        message: decision.message,
      });
      if (decision.state === "not_accessible" && decision.savedQuery) {
        refusals.push(
          recordDashboardRefusal(caller, decision.savedQuery.id, ref)
        );
      }
      continue;
    }
    const timeColumn = timeRange === null ? undefined : decision.timeColumn;
    const key = JSON.stringify([decision.savedQuery.id, timeColumn ?? null]);
    const group = groups.get(key);
    if (group) group.panelIds.push(panel.id);
    else groups.set(key, { decision, timeColumn, panelIds: [panel.id] });
  }

  const runGroup = async ({ decision, timeColumn, panelIds }: RunGroup) => {
    const { savedQuery } = decision;
    let line: Omit<PanelLine, "panel_id">;
    try {
      const result = await runQuery({
        caller,
        entryPoint: "dashboard",
        body:
          timeColumn !== undefined && timeRange !== null
            ? withTimeFilter(savedQuery.query, timeColumn, timeRange)
            : savedQuery.query,
        savedQuery: { id: savedQuery.id, sourceId: savedQuery.sourceId },
        signal,
        userLimits,
        dashboard: { ...ref, now },
      });
      line = {
        state: "ok",
        result: resultOf(result),
        ...(result.cached_at && { cached_at: result.cached_at }),
      };
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof SavedQueryNotAccessibleError) {
        line = {
          state: "not_accessible",
          message: PANEL_MESSAGES.not_accessible,
        };
      } else if (err instanceof AppError) {
        line = {
          state: "ok",
          error: { error: err.code, error_description: err.message },
        };
      } else {
        logger.error(
          { err, dashboard_id: dashboard.id, saved_query_id: savedQuery.id },
          "a dashboard panel's run failed"
        );
        line = {
          state: "ok",
          error: {
            error: "server_error",
            error_description: "An unexpected error occurred",
          },
        };
      }
    }
    for (const panelId of panelIds) await emit({ panel_id: panelId, ...line });
  };

  const queue = [...groups.values()];
  const userLimits =
    queue.length === 0
      ? undefined
      : await loadUserLimits({
          userId: caller.userId,
          groupIds: await groupIdsOf(caller),
        });
  const width = Math.max(
    1,
    Math.min(
      userLimits?.queryConcurrency ?? 1,
      env.DASHBOARD_PARALLELISM,
      queue.length
    )
  );
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      signal.throwIfAborted();
      await runGroup(next);
    }
  };
  try {
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    // Recorded whatever became of the runs; each never throws.
    await Promise.all(refusals);
  }
  await emit(DONE_LINE);
};
