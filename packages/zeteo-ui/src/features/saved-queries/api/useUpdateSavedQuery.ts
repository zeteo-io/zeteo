import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { SavedQuery, UpdateSavedQuery } from "./types";

export const useUpdateSavedQuery = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<
    SavedQuery,
    ApiError,
    { id: string; body: UpdateSavedQuery }
  >({
    mutationFn: async ({ id, body }) => {
      try {
        return (await api.patch<SavedQuery>(`/v1/saved-queries/${id}`, body))
          .data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["saved-queries"] }),
  });
};
