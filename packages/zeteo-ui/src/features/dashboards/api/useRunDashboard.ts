import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { PanelLine, PanelResult, PanelState } from "./types";
import { useCallback, useEffect, useRef, useState } from "react";
import { INTERRUPTED, readErrorBody, readLines } from "./ndjson";
import type { TimeRangeKey } from "./types";
import { isAxiosError } from "axios";

/** What a viewer has of one panel's runs. */
export interface PanelRun {
  /** From the last line about it; undefined until one came. */
  state?: PanelState;
  message?: string;
  /** The last good result: kept when a later refresh fails. */
  result?: PanelResult;
  /** When `result` was current (the cache's time for a cached one). */
  updatedAt?: string;
  /** When a refresh first failed after `result`; cleared by the next good one. */
  staleSince?: string;
  /** Why the last refresh failed. */
  error?: { error: string; error_description: string };
  loading: boolean;
}

export interface RunOptions {
  /** Only these panels (a panel's refresh button); all when left out. */
  panels?: string[];
  /** The range for this run: null for none, left out for the dashboard's own. */
  timeRange?: TimeRangeKey | null;
}

const isDone = (line: unknown) =>
  typeof line === "object" &&
  line !== null &&
  (line as { done?: unknown }).done === true;

/** The panel after a refresh that failed: its last result kept, marked stale. */
const failed = (
  prev: PanelRun | undefined,
  error: PanelRun["error"],
  now: string
): PanelRun => ({
  ...prev,
  loading: false,
  error,
  ...(prev?.result && { staleSince: prev.staleSince ?? now }),
});

const applyLine = (prev: PanelRun | undefined, line: PanelLine): PanelRun => {
  const now = new Date().toISOString();
  if (line.state !== "ok") {
    // A decision, not a failed refresh: nothing of an earlier result stays.
    return { state: line.state, message: line.message, loading: false };
  }
  if (line.result) {
    return {
      state: "ok",
      result: line.result,
      updatedAt: line.cached_at ?? now,
      loading: false,
    };
  }
  return { ...failed(prev, line.error, now), state: "ok" };
};

/**
 * Runs a dashboard as the viewer and keeps each panel's state as its line of
 * the NDJSON stream arrives. `run` starts a run (a new full run stops the one
 * before); every panel keeps its last good result through failed refreshes.
 * Used by the dashboard page and the display.
 */
export const useRunDashboard = (
  dashboardId: string,
  /** The dashboard's panels, so a full run that fails before any line marks each of them. */
  panelIds: readonly string[] = []
) => {
  const api = useZeteoApi();
  const [panels, setPanels] = useState<Record<string, PanelRun>>({});
  const [running, setRunning] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const fullRun = useRef<AbortController | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const known = useRef<string[]>([]);
  useEffect(() => {
    known.current = [...new Set([...panelIds, ...Object.keys(panels)])];
  }, [panelIds, panels]);

  useEffect(() => {
    const all = controllers.current;
    return () => {
      for (const c of all) c.abort();
    };
  }, []);

  const run = useCallback(
    async ({ panels: only, timeRange }: RunOptions = {}) => {
      const controller = new AbortController();
      if (!only) {
        fullRun.current?.abort();
        fullRun.current = controller;
      }
      controllers.current.add(controller);
      // The panels this run is about: those named, else every one seen so far.
      const waiting = new Set<string>(only ?? known.current);
      setRunning((n) => n + 1);
      setError(null);
      setPanels((prev) => {
        const next = { ...prev };
        for (const id of waiting) next[id] = { ...next[id], loading: true };
        return next;
      });
      let done = false;
      try {
        const res = await api.post<ReadableStream<Uint8Array>>(
          `/v1/dashboards/${dashboardId}/run`,
          {
            ...(only && { panels: only }),
            ...(timeRange !== undefined && { time_range: timeRange }),
          },
          {
            adapter: "fetch",
            responseType: "stream",
            signal: controller.signal,
          }
        );
        await readLines(res.data, (line) => {
          if (controller.signal.aborted) return;
          if (isDone(line)) {
            done = true;
            return;
          }
          const panelLine = line as PanelLine;
          waiting.delete(panelLine.panel_id);
          setPanels((prev) => ({
            ...prev,
            [panelLine.panel_id]: applyLine(
              prev[panelLine.panel_id],
              panelLine
            ),
          }));
        });
        if (!done && !controller.signal.aborted) {
          throw INTERRUPTED;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (isAxiosError(err) && err.response) {
          err.response.data = await readErrorBody(err.response.data);
        }
        const apiError = toApiError(err);
        setError(apiError);
        const now = new Date().toISOString();
        const reason = {
          error: apiError.code,
          error_description: apiError.message,
        };
        setPanels((prev) => {
          const next = { ...prev };
          for (const id of waiting) next[id] = failed(prev[id], reason, now);
          return next;
        });
      } finally {
        controllers.current.delete(controller);
        if (fullRun.current === controller) fullRun.current = null;
        setRunning((n) => n - 1);
      }
    },
    [api, dashboardId]
  );

  return { panels, running: running > 0, error, run };
};
