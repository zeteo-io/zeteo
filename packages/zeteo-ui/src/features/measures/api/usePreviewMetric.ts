import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { MetricPreviewBody, PreviewResult } from "./types";
import { useMutation } from "@tanstack/react-query";

/** Runs a draft metric, not saved, as a metric query against the caller's own grants. */
export const usePreviewMetric = (sourceId: string) => {
  const api = useZeteoApi();
  return useMutation<PreviewResult, ApiError, MetricPreviewBody>({
    mutationFn: async (body) => {
      try {
        return (
          await api.post<PreviewResult>(
            `/v1/sources/${sourceId}/metrics/preview`,
            body
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
