import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { RefreshSummary, SyncSummary } from "./types";

export const useRefreshSource = (sourceId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<RefreshSummary | SyncSummary, ApiError, void>({
    mutationFn: async () => {
      try {
        return (
          await api.post<RefreshSummary | SyncSummary>(
            `/v1/sources/${sourceId}/refresh`
          )
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
