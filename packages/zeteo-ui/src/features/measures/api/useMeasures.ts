import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { MeasureListItem } from "./types";

export const measuresKey = (sourceId: string) => [
  "sources",
  sourceId,
  "measures",
];

/** A source's measures, as the caller may see them. */
export const useMeasures = (sourceId: string) => {
  const api = useZeteoApi();
  return useQuery<MeasureListItem[], ApiError>({
    queryKey: measuresKey(sourceId),
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (
          await api.get<{ data: MeasureListItem[] }>(
            `/v1/sources/${sourceId}/measures`,
            { signal }
          )
        ).data.data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
