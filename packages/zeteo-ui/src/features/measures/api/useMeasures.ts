import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { MeasureList } from "./types";

export const measuresKey = (sourceId: string) => [
  "sources",
  sourceId,
  "measures",
];

/** A source's measures, as the caller may see them, and what the caller may change. */
export const useMeasures = (sourceId: string) => {
  const api = useZeteoApi();
  return useQuery<MeasureList, ApiError>({
    queryKey: measuresKey(sourceId),
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (
          await api.get<MeasureList>(`/v1/sources/${sourceId}/measures`, {
            signal,
          })
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
