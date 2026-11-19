import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Metric, MetricInput } from "./types";
import { metricsKey } from "./useMetrics";

interface Save {
  /** The metric to change; absent to create one. */
  id?: string;
  /** For a change, only what differs. */
  body: Partial<MetricInput>;
}

export const useSaveMetric = (sourceId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Metric, ApiError, Save>({
    mutationFn: async ({ id, body }) => {
      try {
        const base = `/v1/sources/${sourceId}/metrics`;
        return (
          id
            ? await api.patch<Metric>(`${base}/${id}`, body)
            : await api.post<Metric>(base, body)
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: metricsKey(sourceId) }),
  });
};
