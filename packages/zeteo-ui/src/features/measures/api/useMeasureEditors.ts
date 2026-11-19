import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { PrincipalRef } from "@/features/principals";
import type { MeasureEditor } from "./types";

const editorsKey = (sourceId: string) => [
  "sources",
  sourceId,
  "measure-editors",
];

/** A source's measure editors. */
export const useMeasureEditors = (sourceId: string) => {
  const api = useZeteoApi();
  return useQuery<MeasureEditor[], ApiError>({
    queryKey: editorsKey(sourceId),
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (
          await api.get<{ data: MeasureEditor[] }>(
            `/v1/sources/${sourceId}/measure-editors`,
            { signal }
          )
        ).data.data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};

/** Replaces the whole list. */
export const useReplaceMeasureEditors = (sourceId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<MeasureEditor[], ApiError, PrincipalRef[]>({
    mutationFn: async (principals) => {
      try {
        return (
          await api.put<{ data: MeasureEditor[] }>(
            `/v1/sources/${sourceId}/measure-editors`,
            { principals }
          )
        ).data.data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(editorsKey(sourceId), data);
      // Who may edit changes what the list shows.
      return queryClient.invalidateQueries({
        queryKey: ["sources", sourceId, "measures"],
      });
    },
  });
};
