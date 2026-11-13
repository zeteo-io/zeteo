import type { QueryRun } from "../../prisma/generated/client/index.js";

export const runView = (row: QueryRun) => ({
  id: row.id,
  user_id: row.userId,
  source_id: row.sourceId,
  entry_point: row.entryPoint,
  query: row.query,
  duration_ms: row.durationMs,
  row_count: row.rowCount,
  outcome: row.outcome,
  error_code: row.errorCode,
  truncated: row.truncated,
  created_at: row.createdAt.toISOString(),
});

export type RunView = ReturnType<typeof runView>;
