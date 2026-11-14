import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";
import type { Source, UpdateSource } from "./types";

export const useUpdateSource = (sourceId: string) => {
  const queryClient = useQueryClient();
  return useMutation<Source, ApiError, UpdateSource>({
    mutationFn: async (body) => {
      try {
        return (await api.patch<Source>(`/v1/sources/${sourceId}`, body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    // A new schema list or connection refreshes the catalogue server-side.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });
};
