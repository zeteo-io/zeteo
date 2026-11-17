import type { ChartSettings, SavedPanel } from "./types";
import { useApiMutation } from "./mutation";
import { useCursorList } from "@/lib/api";

/** The caller's own saved panels, or those shared with them; newest first. */
export const useSavedPanels = (scope: "mine" | "shared") =>
  useCursorList<SavedPanel>(["saved-panels", scope], "/v1/saved-panels", {
    scope,
  });

export interface SavedPanelInput {
  name: string;
  description?: string;
  saved_query_id: string;
  chart: ChartSettings;
  time_column?: string;
}

const SAVED_PANELS = ["saved-panels"];
// A saved panel's change shows on the dashboards that link it.
const AND_DASHBOARDS = [SAVED_PANELS, ["dashboards"]];

export const useCreateSavedPanel = () =>
  useApiMutation<SavedPanel, SavedPanelInput>(
    (api, body) => api.post("/v1/saved-panels", body),
    [SAVED_PANELS]
  );

export const useUpdateSavedPanel = () =>
  useApiMutation<
    SavedPanel,
    {
      id: string;
      changes: Partial<Omit<SavedPanelInput, "time_column">> & {
        time_column?: string | null;
      };
    }
  >(
    (api, { id, changes }) => api.patch(`/v1/saved-panels/${id}`, changes),
    AND_DASHBOARDS
  );

export const useDeleteSavedPanel = () =>
  useApiMutation<void, string>(
    (api, id) => api.delete(`/v1/saved-panels/${id}`),
    AND_DASHBOARDS
  );

export const useCopySavedPanel = () =>
  useApiMutation<SavedPanel, { id: string; name: string }>(
    (api, { id, name }) => api.post(`/v1/saved-panels/${id}/copy`, { name }),
    [SAVED_PANELS]
  );
