import type { ChartSettings, Panel, SavedPanel } from "./types";
import { useApiMutation } from "./mutation";

/** A new panel: own (a saved query and its chart) or linked (a saved panel); placed by the server. */
export type NewPanel =
  | {
      kind: "own";
      saved_query_id: string;
      chart: ChartSettings;
      time_column?: string;
      title?: string;
    }
  | { kind: "linked"; saved_panel_id: string; title?: string };

export interface PanelChanges {
  title?: string | null;
  saved_query_id?: string;
  chart?: ChartSettings;
  time_column?: string | null;
}

const keys = (dashboardId: string) => [
  ["dashboards", dashboardId],
  ["saved-panels"],
];

/** The panel mutations of one dashboard; each refreshes the dashboard. */
export const usePanels = (dashboardId: string) => {
  const base = `/v1/dashboards/${dashboardId}/panels`;
  return {
    add: useApiMutation<Panel, NewPanel>(
      (api, body) => api.post(base, body),
      keys(dashboardId)
    ),
    update: useApiMutation<Panel, { panelId: string; changes: PanelChanges }>(
      (api, { panelId, changes }) => api.patch(`${base}/${panelId}`, changes),
      keys(dashboardId)
    ),
    remove: useApiMutation<void, string>(
      (api, panelId) => api.delete(`${base}/${panelId}`),
      keys(dashboardId)
    ),
    detach: useApiMutation<Panel, string>(
      (api, panelId) => api.post(`${base}/${panelId}/detach`),
      keys(dashboardId)
    ),
    saveAs: useApiMutation<
      SavedPanel,
      { panelId: string; name: string; description?: string }
    >(
      (api, { panelId, ...body }) => api.post(`${base}/${panelId}/save`, body),
      keys(dashboardId)
    ),
  };
};
