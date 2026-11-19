import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { MeasureInput, PreviewResult } from "./types";
import { useMutation } from "@tanstack/react-query";

/** Runs a draft measure, not saved, against the caller's own grants. */
export const usePreviewMeasure = (sourceId: string) => {
  const api = useZeteoApi();
  return useMutation<PreviewResult, ApiError, MeasureInput>({
    mutationFn: async (measure) => {
      try {
        return (
          await api.post<PreviewResult>(
            `/v1/sources/${sourceId}/measures/preview`,
            { measure }
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
