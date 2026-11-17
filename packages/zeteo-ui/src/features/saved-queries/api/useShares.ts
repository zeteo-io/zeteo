import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Share } from "./types";

/** Who a saved query is shared with. */
export const useShares = (savedQueryId: string) => {
  const api = useZeteoApi();
  return useQuery<Share[], ApiError>({
    queryKey: ["saved-queries", savedQueryId, "shares"],
    retry: false,
    queryFn: async () => {
      try {
        return (
          await api.get<{ data: Share[] }>(
            `/v1/saved-queries/${savedQueryId}/shares`
          )
        ).data.data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
