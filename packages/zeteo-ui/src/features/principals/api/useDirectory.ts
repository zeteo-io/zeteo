import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Principal } from "./usePrincipalNames";
import { useQuery } from "@tanstack/react-query";

/** The whole directory, as `GET /v1/principals/all` and `/v1/me/principals/all` give it. */
export interface Directory {
  data: Principal[];
  /** More than 5000 users or groups: some are left out. */
  truncated: boolean;
}

/**
 * `admin`: every user and group (`zeteo.grants.read`); `mine`: everyone the
 * caller may share with (`zeteo.data.read`).
 */
export type DirectoryScope = "admin" | "mine";

const PATH: Record<DirectoryScope, string> = {
  admin: "/v1/principals/all",
  mine: "/v1/me/principals/all",
};

// Each read pages through all of Tereo and counts as a search, so it is kept.
const STALE_MS = 5 * 60_000;

/** Every user and group in `scope`, loaded once and kept five minutes; `enabled: false` asks nothing. */
export const useDirectory = (scope: DirectoryScope, enabled = true) => {
  const api = useZeteoApi();
  return useQuery<Directory, ApiError>({
    queryKey: ["principals", "directory", scope],
    enabled,
    staleTime: STALE_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (await api.get<Directory>(PATH[scope], { signal })).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
