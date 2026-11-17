import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { SavedQuery } from "./types";

export const useCopySavedQuery = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<SavedQuery, ApiError, { id: string; name: string }>({
    mutationFn: async ({ id, name }) => {
      try {
        return (
          await api.post<SavedQuery>(`/v1/saved-queries/${id}/copy`, { name })
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["saved-queries"] }),
  });
};
