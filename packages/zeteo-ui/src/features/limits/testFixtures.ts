import type { PrincipalLimit } from "./api/types";

export const LIMIT_ID = "f1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const LIMIT_USER_ID = "b1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const LIMIT_GROUP_ID = "b2222222-1c7a-4a53-9d0e-6a3b1f2c4d02";

export const makeLimit = (
  over: Partial<PrincipalLimit> = {}
): PrincipalLimit => ({
  id: LIMIT_ID,
  principal_type: "user",
  principal_id: LIMIT_USER_ID,
  principal_status: "active",
  query_concurrency: 8,
  export_concurrency: 3,
  created_by: "b9999999-1c7a-4a53-9d0e-6a3b1f2c4d09",
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  ...over,
});
