import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Share } from "./types";
import {
  objectPath,
  resourceKey,
  type SharedObjectType,
} from "./sharedObjects";

/** Who a saved query, dashboard or saved panel is shared with. */
export const useShares = (objectType: SharedObjectType, id: string) => {
  const api = useZeteoApi();
  return useQuery<Share[], ApiError>({
    queryKey: [...resourceKey(objectType), id, "shares"],
    retry: false,
    queryFn: async () => {
      try {
        return (
          await api.get<{ data: Share[] }>(
            `${objectPath(objectType, id)}/shares`
          )
        ).data.data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
