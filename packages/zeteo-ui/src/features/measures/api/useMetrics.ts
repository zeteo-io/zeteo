import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { MetricList } from "./types";

export const metricsKey = (sourceId: string) => [
  "sources",
  sourceId,
  "metrics",
];

/** A source's metrics, as the caller may see them, and what the caller may change. */
export const useMetrics = (sourceId: string) => {
  const api = useZeteoApi();
  return useQuery<MetricList, ApiError>({
    queryKey: metricsKey(sourceId),
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (
          await api.get<MetricList>(`/v1/sources/${sourceId}/metrics`, {
            signal,
          })
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
