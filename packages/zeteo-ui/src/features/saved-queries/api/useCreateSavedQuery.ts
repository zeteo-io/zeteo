import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { CreateSavedQuery, SavedQuery } from "./types";

export const useCreateSavedQuery = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<SavedQuery, ApiError, CreateSavedQuery>({
    mutationFn: async (body) => {
      try {
        return (await api.post<SavedQuery>("/v1/saved-queries", body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["saved-queries"] }),
  });
};
