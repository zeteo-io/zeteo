import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";
import type { CreateGrant, Grant } from "./types";

export const useCreateGrant = () => {
  const queryClient = useQueryClient();
  return useMutation<Grant, ApiError, CreateGrant>({
    mutationFn: async (body) => {
      try {
        return (await api.post<Grant>("/v1/grants", body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grants"] }),
  });
};
