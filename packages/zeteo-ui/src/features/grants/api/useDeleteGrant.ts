import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";

export const useDeleteGrant = () => {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: async (grantId) => {
      try {
        await api.delete(`/v1/grants/${grantId}`);
      } catch (err) {
        throw toApiError(err);
      }
    },
    // The removed grant's own query would only come back 404.
    onSuccess: (_data, grantId) =>
      queryClient.invalidateQueries({
        queryKey: ["grants"],
        predicate: (query) => query.queryKey[1] !== grantId,
      }),
  });
};
