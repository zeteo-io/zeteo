import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";
import type { DeclareRelation, Relation } from "./types";

export const useDeclareRelation = (sourceId: string) => {
  const queryClient = useQueryClient();
  return useMutation<Relation, ApiError, DeclareRelation>({
    mutationFn: async (body) => {
      try {
        return (
          await api.post<Relation>(`/v1/sources/${sourceId}/relations`, body)
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    // A table's page lists the relations that start at it.
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
