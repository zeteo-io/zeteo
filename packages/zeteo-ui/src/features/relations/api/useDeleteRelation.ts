import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";

export const useDeleteRelation = (sourceId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: async (relationId) => {
      try {
        await api.delete(`/v1/sources/${sourceId}/relations/${relationId}`);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["sources", sourceId, "relations"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["sources", sourceId, "tables"],
        }),
      ]),
  });
};
