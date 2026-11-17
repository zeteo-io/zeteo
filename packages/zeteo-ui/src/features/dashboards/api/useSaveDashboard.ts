import type { Dashboard, DashboardTheme, TimeRangeKey } from "./types";
import { useApiMutation } from "./mutation";

export interface DashboardDetails {
  name?: string;
  description?: string;
  time_range?: TimeRangeKey | null;
  refresh_seconds?: number | null;
  theme?: DashboardTheme;
}

/** A panel of a whole-layout save: an existing one by id (keeping its id), with its place. */
export interface PlacedPanel {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DASHBOARDS = ["dashboards"];

export const useCreateDashboard = () =>
  useApiMutation<Dashboard, DashboardDetails & { name: string }>(
    (api, body) => api.post("/v1/dashboards", body),
    [DASHBOARDS]
  );

/** Changes a dashboard's details, or its whole layout (`panels`, every panel kept listed by id). */
export const useSaveDashboard = (dashboardId: string) =>
  useApiMutation<Dashboard, DashboardDetails & { panels?: PlacedPanel[] }>(
    (api, body) => api.patch(`/v1/dashboards/${dashboardId}`, body),
    [DASHBOARDS]
  );

export const useDeleteDashboard = () =>
  useApiMutation<void, string>(
    (api, id) => api.delete(`/v1/dashboards/${id}`),
    [DASHBOARDS]
  );

export const useCopyDashboard = () =>
  useApiMutation<Dashboard, { id: string; name: string }>(
    (api, { id, name }) => api.post(`/v1/dashboards/${id}/copy`, { name }),
    [DASHBOARDS]
  );
