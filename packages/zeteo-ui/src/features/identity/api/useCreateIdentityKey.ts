import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { IdentityKey } from "./types";

export interface CreateIdentityKey {
  name: string;
  label: string;
  description?: string;
}

export const useCreateIdentityKey = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<IdentityKey, ApiError, CreateIdentityKey>({
    mutationFn: async (body) => {
      try {
        return (await api.post<IdentityKey>("/v1/identity-keys", body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["identity-keys"] }),
  });
};
