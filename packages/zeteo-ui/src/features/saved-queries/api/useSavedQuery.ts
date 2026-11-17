import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { SavedQuery } from "./types";

/** One saved query as the caller may see it; a 404 when they may not. */
export const useSavedQuery = (savedQueryId: string) => {
  const api = useZeteoApi();
  return useQuery<SavedQuery, ApiError>({
    // Under ["saved-queries"], so every saved-query mutation refreshes it.
    queryKey: ["saved-queries", savedQueryId],
    retry: false,
    queryFn: async () => {
      try {
        return (await api.get<SavedQuery>(`/v1/saved-queries/${savedQueryId}`))
          .data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
