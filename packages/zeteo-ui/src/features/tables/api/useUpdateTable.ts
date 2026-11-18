import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { PatchTable, TableDetail } from "./types";

export const useUpdateTable = (sourceId: string, tableId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<TableDetail, ApiError, PatchTable>({
    mutationFn: async (body) => {
      try {
        return (
          await api.patch<TableDetail>(
            `/v1/sources/${sourceId}/tables/${tableId}`,
            body
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["sources", sourceId, "tables"],
      });
    },
  });
};
