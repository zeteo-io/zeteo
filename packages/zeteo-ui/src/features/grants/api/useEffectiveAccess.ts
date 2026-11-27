import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { PrincipalType } from "@/features/principals";
import { useQuery } from "@tanstack/react-query";
import type { RowAccess } from "./types";

export type EffectiveWarning =
  | { code: "all_rows_overrides"; grant_id: string }
  | { code: "missing_identity_value"; key: string }
  | { code: "row_rule_unavailable"; reason: string }
  | { code: "merged_members_limited"; member_table_ids: string[] }
  | {
      code: "org_scoped_rule_inactive";
      group_id: string;
      group_name: string | null;
      organization_id: string;
      organization_name: string | null;
    };

/** `GET /v1/grants/effective`: what one person gets of one table, and why. */
export interface EffectiveAccess {
  columns: "all" | string[];
  rows: "all" | "limited" | "none";
  rule_summary: string | null;
  grants: {
    grant_id: string;
    principal_type: PrincipalType;
    principal_id: string;
    row_access: RowAccess;
  }[];
  warnings: EffectiveWarning[];
  /** The organizations of the user's groups. */
  organizations: { id: string; name: string | null }[];
}

/**
 * `organizationId` asks as if the user were signed in to that organization,
 * whose groups then count; absent, signed in to none.
 */
export const useEffectiveAccess = (
  userId: string | undefined,
  tableId: string,
  organizationId?: string
) => {
  const api = useZeteoApi();
  return useQuery<EffectiveAccess, ApiError>({
    queryKey: ["grants", "effective", userId, tableId, organizationId ?? null],
    enabled: userId !== undefined,
    retry: false,
    queryFn: async () => {
      try {
        return (
          await api.get<EffectiveAccess>("/v1/grants/effective", {
            params: {
              user_id: userId,
              table_id: tableId,
              ...(organizationId && { organization_id: organizationId }),
            },
          })
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
