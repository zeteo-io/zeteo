import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreatePrincipalLimit, PrincipalLimit } from "./types";
import { api, toApiError, type ApiError } from "@/lib/api";

export const useCreateLimit = () => {
  const queryClient = useQueryClient();
  return useMutation<PrincipalLimit, ApiError, CreatePrincipalLimit>({
    mutationFn: async (body) => {
      try {
        return (await api.post<PrincipalLimit>("/v1/principal-limits", body))
          .data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["principal-limits"] }),
  });
};
