import type { Run } from "./api/types";

export const RUN_ID = "a1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const RUN_USER_ID = "b1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";

export const makeRun = (over: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  user_id: RUN_USER_ID,
  source_id: "5f0c8f0e-1c7a-4a53-9d0e-6a3b1f2c4d55",
  entry_point: "api",
  query: { from: "orders", limit: 10 },
  duration_ms: 1500,
  row_count: 10,
  outcome: "ok",
  error_code: null,
  truncated: false,
  created_at: "2026-11-01T10:00:00.000Z",
  ...over,
});
