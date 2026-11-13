import type { PrincipalLimit } from "../../prisma/generated/client/index.js";
import type { PrincipalStatus } from "../grants/principals.js";

export const principalLimitView = (
  row: PrincipalLimit,
  principalStatus: PrincipalStatus
) => ({
  id: row.id,
  principal_type: row.principalType,
  principal_id: row.principalId,
  principal_status: principalStatus,
  query_concurrency: row.queryConcurrency,
  export_concurrency: row.exportConcurrency,
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

export type PrincipalLimitView = ReturnType<typeof principalLimitView>;
