import type { PanelRun } from "../api/useRunDashboard";
import type { Dashboard } from "../api/types";

/**
 * The panels whose last line disagrees with the dashboard as loaded: a state
 * other than the panel's, or a panel the dashboard does not have yet. Empty
 * when they agree; a key that changes when what disagrees does.
 */
export const disagreement = (
  dashboard: Dashboard | undefined,
  runs: Record<string, PanelRun>
): string => {
  if (!dashboard) return "";
  const byId = new Map(dashboard.panels.map((p) => [p.id, p]));
  return Object.entries(runs)
    .filter(([id, run]) => {
      if (run.state === undefined || run.loading) return false;
      const panel = byId.get(id);
      return (
        !panel ||
        panel.state !== run.state ||
        (run.state === "ok" && panel.chart === undefined)
      );
    })
    .map(([id, run]) => `${id}:${run.state}`)
    .sort()
    .join(",");
};
