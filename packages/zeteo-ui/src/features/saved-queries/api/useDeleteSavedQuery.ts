import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";

export const useDeleteSavedQuery = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      try {
        await api.delete(`/v1/saved-queries/${id}`);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["saved-queries"] }),
  });
};
