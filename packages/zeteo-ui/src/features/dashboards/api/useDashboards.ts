import type { DashboardSummary } from "./types";
import { useCursorList } from "@/lib/api";

/** The caller's own dashboards, or those shared with them; newest first. */
export const useDashboards = (scope: "mine" | "shared") =>
  useCursorList<DashboardSummary>(["dashboards", scope], "/v1/dashboards", {
    scope,
  });
