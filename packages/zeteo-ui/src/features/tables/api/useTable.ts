import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { TableDetail } from "./types";

export const useTable = (
  sourceId: string | undefined,
  tableId: string | undefined
) => {
  const api = useZeteoApi();
  return useQuery<TableDetail, ApiError>({
    queryKey: ["sources", sourceId, "tables", tableId],
    enabled: sourceId !== undefined && tableId !== undefined,
    queryFn: async () => {
      try {
        return (
          await api.get<TableDetail>(
            `/v1/sources/${sourceId}/tables/${tableId}`
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
