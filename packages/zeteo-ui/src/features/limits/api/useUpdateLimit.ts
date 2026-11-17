import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PrincipalLimit, UpdatePrincipalLimit } from "./types";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";

export const useUpdateLimit = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<
    PrincipalLimit,
    ApiError,
    { id: string; body: UpdatePrincipalLimit }
  >({
    mutationFn: async ({ id, body }) => {
      try {
        return (
          await api.patch<PrincipalLimit>(`/v1/principal-limits/${id}`, body)
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["principal-limits"] }),
  });
};
