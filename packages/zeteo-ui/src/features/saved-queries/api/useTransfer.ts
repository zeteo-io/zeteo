import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { TransferResult } from "./types";

export const useTransfer = (savedQueryId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<
    TransferResult,
    ApiError,
    { user_id: string; keep_access: boolean }
  >({
    mutationFn: async (body) => {
      try {
        return (
          await api.post<TransferResult>(
            `/v1/saved-queries/${savedQueryId}/transfer`,
            body
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
