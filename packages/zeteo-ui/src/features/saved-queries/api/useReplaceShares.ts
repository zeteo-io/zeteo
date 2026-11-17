import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { ReplaceSharesResult, ShareRef } from "./types";

/** Replaces the whole list of people and groups a saved query is shared with. */
export const useReplaceShares = (savedQueryId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<ReplaceSharesResult, ApiError, ShareRef[]>({
    mutationFn: async (principals) => {
      try {
        return (
          await api.put<ReplaceSharesResult>(
            `/v1/saved-queries/${savedQueryId}/shares`,
            { principals }
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["saved-queries"] }),
  });
};
