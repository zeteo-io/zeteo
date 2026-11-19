import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Table } from "@/features/tables";

/** The body of `POST /v1/sources/:id/merged-tables` and `PUT …/tables/:tableId/merged`. */
export interface MergedTableBody {
  name: string;
  label_column: string;
  members: { table_id: string; label: string }[];
  columns: { name: string; from_name: string; include: boolean }[];
}

/** One column of the members' union: which members have it, and its type. */
export interface UnionColumn {
  name: string;
  /** The resolved type: text when the members disagree. */
  type: string;
  members: string[];
  /** The distinct types its members give it; more than one means they disagree. */
  types: string[];
}

/** `GET /v1/sources/:id/merged-tables/columns`: the union and each member's suggested label. */
export interface MergedColumns {
  columns: UnionColumn[];
  labels: Record<string, string>;
}

const KEY = ["sources"];

/** The column union and suggested labels of the chosen members (two or more). */
export const useMergedColumns = (
  sourceId: string,
  memberIds: string[],
  enabled = true
) => {
  const api = useZeteoApi();
  const ids = [...memberIds].sort();
  return useQuery<MergedColumns, ApiError>({
    queryKey: [...KEY, sourceId, "merged-columns", ids],
    enabled: enabled && ids.length >= 2,
    retry: false,
    queryFn: async ({ signal }) => {
      const query = ids.map((id) => `member=${encodeURIComponent(id)}`);
      try {
        return (
          await api.get<MergedColumns>(
            `/v1/sources/${sourceId}/merged-tables/columns?${query.join("&")}`,
            { signal }
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};

/** Creates a merged table, or (with `tableId`) replaces its definition; answers with the table. */
export const useSaveMergedTable = (sourceId: string, tableId?: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Table, ApiError, MergedTableBody>({
    mutationFn: async (body) => {
      try {
        return (
          await (tableId
            ? api.put<Table>(
                `/v1/sources/${sourceId}/tables/${tableId}/merged`,
                body
              )
            : api.post<Table>(`/v1/sources/${sourceId}/merged-tables`, body))
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ["grants"] });
    },
  });
};
