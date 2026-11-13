import type { RunOutcome } from "../../prisma/generated/client/index.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import type { Prisma } from "../utils/db/index.js";
import { AppError } from "../utils/errors.js";
import type { EntryPoint } from "./limits.js";

export interface RunRecord {
  caller: Caller;
  /** Null when the query named no source the caller can see. */
  sourceId: string | null;
  entryPoint: EntryPoint;
  /** The body as the caller sent it. */
  query: unknown;
  durationMs: number;
  /** Null unless the run succeeded. */
  rowCount: number | null;
  outcome: RunOutcome;
  errorCode: string | null;
  truncated: boolean;
}

/** The code recorded for a run whose client went away before it ended. */
export const CLIENT_CLOSED = "client_closed";

/**
 * How a failed run is recorded: a 4xx is `refused`, `query_timeout` is
 * `timeout`, anything else `failed` (an error that is not an `AppError` as
 * `server_error`).
 */
export const failureOf = (
  err: unknown
): { outcome: RunOutcome; errorCode: string } => {
  if (!(err instanceof AppError)) {
    return { outcome: "failed", errorCode: "server_error" };
  }
  if (err.code === "query_timeout") {
    return { outcome: "timeout", errorCode: err.code };
  }
  return {
    outcome: err.statusCode < 500 ? "refused" : "failed",
    errorCode: err.code,
  };
};

/**
 * Writes the `query_runs` row and its `zeteo.query.run` audit entry in one
 * transaction, and returns the run's id. The query is kept in the row only;
 * neither holds any of the result.
 */
export const recordRun = (run: RunRecord): Promise<string> =>
  withAudit(async (tx, audit) => {
    const row = await tx.queryRun.create({
      data: {
        userId: run.caller.userId,
        sourceId: run.sourceId,
        entryPoint: run.entryPoint,
        query: run.query as Prisma.InputJsonValue,
        durationMs: run.durationMs,
        rowCount: run.rowCount,
        outcome: run.outcome,
        errorCode: run.errorCode,
        truncated: run.truncated,
      },
      select: { id: true },
    });
    audit({
      action: AUDIT_EVENTS.queryRun,
      resourceType: "query_run",
      resourceId: row.id,
      actorId: run.caller.userId,
      metadata: {
        source_id: run.sourceId,
        entry_point: run.entryPoint,
        outcome: run.outcome,
        error_code: run.errorCode,
        row_count: run.rowCount,
        duration_ms: run.durationMs,
      },
    });
    return row.id;
  });
