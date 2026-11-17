import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { TransferResult } from "./types";
import {
  objectPath,
  resourceKey,
  type SharedObjectType,
} from "./sharedObjects";

/** Hands an object to another person. Only a saved query's answer can carry a `warning`. */
export const useTransfer = (objectType: SharedObjectType, id: string) => {
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
            `${objectPath(objectType, id)}/transfer`,
            body
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: resourceKey(objectType) }),
  });
};
