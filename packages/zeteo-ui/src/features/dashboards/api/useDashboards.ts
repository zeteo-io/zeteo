import type { DashboardSummary } from "./types";
import { useCursorList } from "@/lib/api";

/** The caller's own dashboards, or those shared with them; newest first. */
export const useDashboards = (scope: "mine" | "shared") =>
  useCursorList<DashboardSummary>(["dashboards", scope], "/v1/dashboards", {
    scope,
  });

export interface AllFilters {
  owner_id?: string;
  q?: string;
}

/** Every dashboard (needs `zeteo.dashboards.read`), newest first, narrowed by the filters. */
export const useAllDashboards = (filters: AllFilters = {}) =>
  useCursorList<DashboardSummary>(["dashboards", "all"], "/v1/dashboards", {
    scope: "all",
    ...filters,
  });
