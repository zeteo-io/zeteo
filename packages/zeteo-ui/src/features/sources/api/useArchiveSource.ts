import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";

export const useArchiveSource = (sourceId: string) => {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: async () => {
      try {
        await api.post(`/v1/sources/${sourceId}/archive`);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });
};
