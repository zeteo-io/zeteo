import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { CreateSource, Source } from "./types";

export const useCreateSource = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Source, ApiError, CreateSource>({
    // The body holds the password: keep nothing once the form is gone.
    gcTime: 0,
    mutationFn: async (body) => {
      try {
        return (await api.post<Source>("/v1/sources", body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });
};
