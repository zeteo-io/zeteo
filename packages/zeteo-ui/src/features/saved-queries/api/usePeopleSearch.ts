import { principalSearchQuery } from "@/features/principals/api/usePrincipalSearch";
import type { ApiError } from "@/lib/api";

/**
 * The search hook for SearchList over `GET /v1/me/principals`, which needs
 * only `zeteo.data.read` (the admin search needs `zeteo.grants.read`).
 */
export const peopleSearchQuery = (
  type: "user" | "group",
  onError?: (error: ApiError | null) => void
) => principalSearchQuery(type, onError, "/v1/me/principals");
