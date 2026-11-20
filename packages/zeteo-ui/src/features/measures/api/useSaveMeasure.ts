import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Measure, MeasureInput } from "./types";
import { measuresKey } from "./useMeasures";

interface Save {
  /** The measure to change; absent to create one. */
  id?: string;
  /** For a change, only what differs; `where: null` removes the filter. */
  body: Partial<MeasureInput> | (MeasureInput & { where?: unknown });
}

export const useSaveMeasure = (sourceId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Measure, ApiError, Save>({
    mutationFn: async ({ id, body }) => {
      try {
        const base = `/v1/sources/${sourceId}/measures`;
        return (
          id
            ? await api.patch<Measure>(`${base}/${id}`, body)
            : await api.post<Measure>(base, body)
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: measuresKey(sourceId) }),
  });
};
