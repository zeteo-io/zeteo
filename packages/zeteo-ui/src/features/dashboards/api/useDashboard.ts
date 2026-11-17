import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Dashboard } from "./types";

/** A failure a later attempt may not meet: anything but a lost session or a missing dashboard. */
const retryUnlessFinal = (_failures: number, err: ApiError) =>
  err.status !== 401 && err.status !== 404;

/** 1 s, then twice as long each time, up to a minute. */
const backOff = (failures: number) => Math.min(1000 * 2 ** failures, 60_000);

interface UseDashboardOptions {
  /**
   * For an unattended screen: a failed load is retried with back-off until
   * it succeeds, unless the session was lost (401) or the dashboard is gone (404).
   */
  retryUntilLoaded?: boolean;
}

/** One dashboard as the caller sees it, each panel decided for them. */
export const useDashboard = (
  dashboardId: string,
  { retryUntilLoaded = false }: UseDashboardOptions = {}
) => {
  const api = useZeteoApi();
  return useQuery<Dashboard, ApiError>({
    queryKey: ["dashboards", dashboardId],
    retry: retryUntilLoaded ? retryUnlessFinal : false,
    retryDelay: backOff,
    queryFn: async () => {
      try {
        return (await api.get<Dashboard>(`/v1/dashboards/${dashboardId}`)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
