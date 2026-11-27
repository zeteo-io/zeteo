import { SOURCE_ID } from "@/features/sources/testFixtures";
import { ORDERS_ID } from "@/features/tables/testFixtures";
import type { Grant } from "./api/types";

export const GRANT_ID = "e1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const USER_ID = "b1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const GROUP_ID = "b2222222-1c7a-4a53-9d0e-6a3b1f2c4d02";

export const makeGrant = (over: Partial<Grant> = {}): Grant => ({
  id: GRANT_ID,
  principal_type: "user",
  principal_id: USER_ID,
  principal_status: "active",
  source: { id: SOURCE_ID, slug: "orders" },
  table: {
    id: ORDERS_ID,
    schema_name: "public",
    name: "orders",
    missing: false,
  },
  all_columns: true,
  columns: [],
  row_access: "unlimited_default",
  row_rule_problems: [],
  created_by: "b9999999-1c7a-4a53-9d0e-6a3b1f2c4d09",
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  ...over,
});
