import { adapterFor } from "../../adapters/index.js";
import { collect } from "../../engine/collect.js";
import { performance } from "node:perf_hooks";
import type {
  PreparedQuery,
  QueryPlan,
  QueryResult,
  RunLimits,
  SourceConnection,
  SourceType,
} from "../../adapters/types.js";

/** A run's limits as a test writes them; the deadline is set when it runs. */
export type TestLimits = Omit<RunLimits, "deadlineAt">;

/**
 * Runs `prepared` on `conn` as the engine does: opens it, reads it within
 * the limits' row and byte caps, and closes it.
 */
export const runPrepared = async (
  conn: SourceConnection,
  prepared: PreparedQuery,
  limits: RunLimits,
  signal?: AbortSignal
): Promise<QueryResult> => {
  const stream = await conn.openQuery(prepared, limits, signal);
  try {
    return { columns: stream.columns, ...(await collect(stream, limits)) };
  } finally {
    await stream.close();
  }
};

/**
 * Runs `plan` on `conn` as the engine does: prepared by the adapter of
 * `type` for one row past `maxRows`, with a deadline `timeoutMs` from now.
 * A plan the adapter refuses to prepare rejects.
 */
export const runPlan = async (
  type: SourceType,
  conn: SourceConnection,
  plan: QueryPlan,
  limits: TestLimits,
  signal?: AbortSignal
): Promise<QueryResult> =>
  runPrepared(
    conn,
    adapterFor(type).prepare(plan, {
      limit: limits.maxRows + 1,
      offset: plan.offset,
    }),
    { ...limits, deadlineAt: performance.now() + limits.timeoutMs },
    signal
  );
