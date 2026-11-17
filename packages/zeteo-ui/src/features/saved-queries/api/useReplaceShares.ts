import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { ReplaceSharesResult, ShareRef } from "./types";
import {
  objectPath,
  resourceKey,
  type SharedObjectType,
} from "./sharedObjects";

/** Replaces the whole list of people and groups an object is shared with. */
export const useReplaceShares = (objectType: SharedObjectType, id: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<ReplaceSharesResult, ApiError, ShareRef[]>({
    mutationFn: async (principals) => {
      try {
        return (
          await api.put<ReplaceSharesResult>(
            `${objectPath(objectType, id)}/shares`,
            { principals }
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
