import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Dashboard } from "./types";

/** One dashboard as the caller sees it, each panel decided for them. */
export const useDashboard = (dashboardId: string) => {
  const api = useZeteoApi();
  return useQuery<Dashboard, ApiError>({
    queryKey: ["dashboards", dashboardId],
    retry: false,
    queryFn: async () => {
      try {
        return (await api.get<Dashboard>(`/v1/dashboards/${dashboardId}`)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
