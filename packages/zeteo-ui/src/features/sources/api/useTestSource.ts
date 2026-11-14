import { api, toApiError, type ApiError } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import type { TestResult } from "./types";

/** Changes nothing on the server, so nothing is invalidated. */
export const useTestSource = (sourceId: string) =>
  useMutation<TestResult, ApiError, void>({
    mutationFn: async () => {
      try {
        return (await api.post<TestResult>(`/v1/sources/${sourceId}/test`))
          .data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
