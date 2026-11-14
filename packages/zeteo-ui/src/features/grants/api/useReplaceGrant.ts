import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";
import type { Grant, ReplaceGrant } from "./types";

export const useReplaceGrant = (grantId: string) => {
  const queryClient = useQueryClient();
  return useMutation<Grant, ApiError, ReplaceGrant>({
    mutationFn: async (body) => {
      try {
        return (await api.put<Grant>(`/v1/grants/${grantId}`, body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: (grant) => {
      queryClient.setQueryData(["grants", grantId], grant);
      return queryClient.invalidateQueries({ queryKey: ["grants"] });
    },
  });
};
