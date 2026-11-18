import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Relation } from "./types";

/** Renames a declared relation. */
export const useRenameRelation = (sourceId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Relation, ApiError, { id: string; name: string }>({
    mutationFn: async ({ id, name }) => {
      try {
        return (
          await api.patch<Relation>(`/v1/sources/${sourceId}/relations/${id}`, {
            name,
          })
        ).data;
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
