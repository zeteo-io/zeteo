import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";
import type { RefreshSummary } from "./types";

export const useRefreshSource = (sourceId: string) => {
  const queryClient = useQueryClient();
  return useMutation<RefreshSummary, ApiError, void>({
    mutationFn: async () => {
      try {
        return (
          await api.post<RefreshSummary>(`/v1/sources/${sourceId}/refresh`)
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    // The source (status, last refresh) and its tables and relations; a failed
    // refresh also sets the source's status to `unreachable`.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });
};
