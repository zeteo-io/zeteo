import type { QueryRun } from "../../prisma/generated/client/index.js";

export const runView = (
  row: QueryRun,
  savedQuery?: { id: string; name: string }
) => ({
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
  ...(savedQuery && {
    saved_query: { id: savedQuery.id, name: savedQuery.name },
  }),
});

export type RunView = ReturnType<typeof runView>;
