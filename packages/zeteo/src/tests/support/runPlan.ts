import { adapterFor } from "../../adapters/index.js";
import { performance } from "node:perf_hooks";
import type {
  QueryPlan,
  QueryResult,
  RunLimits,
  SourceConnection,
  SourceType,
} from "../../adapters/types.js";

/** A run's limits as a test writes them; the deadline is set when it runs. */
export type TestLimits = Omit<RunLimits, "deadlineAt">;

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
  conn.runQuery(
    adapterFor(type).prepare(plan, {
      limit: limits.maxRows + 1,
      offset: plan.offset,
    }),
    { ...limits, deadlineAt: performance.now() + limits.timeoutMs },
    signal
  );
