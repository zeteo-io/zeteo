import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";

export const useDeleteLimit = () => {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      try {
        await api.delete(`/v1/principal-limits/${id}`);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["principal-limits"] }),
  });
};
