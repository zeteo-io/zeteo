import type { RunOutcome } from "../../prisma/generated/client/index.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { EXPORT_TIMEOUT_MS, type EntryPoint } from "./limits.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import type { Prisma } from "../utils/db/index.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface RunRecord {
  caller: Caller;
  /** Null when the query named no source the caller can see. */
  sourceId: string | null;
  entryPoint: EntryPoint;
  /** The body as the caller sent it. */
  query: unknown;
  durationMs: number;
  /** Null unless the run succeeded; for an export that started, the rows passed to its reader. */
  rowCount: number | null;
  outcome: RunOutcome;
  errorCode: string | null;
  truncated: boolean;
}

/** Stored in place of a query that could not be stored itself. */
export const UNRECORDABLE_QUERY = { unrecordable: true } as const;

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

/** The run's audit metadata: never the query, never any of the result. */
const runMetadata = (
  run: Pick<RunRecord, "sourceId" | "entryPoint">,
  end: Pick<RunRecord, "outcome" | "errorCode" | "rowCount" | "durationMs">
) => ({
  source_id: run.sourceId,
  entry_point: run.entryPoint,
  outcome: end.outcome,
  error_code: end.errorCode,
  row_count: end.rowCount,
  duration_ms: end.durationMs,
});

/**
 * Writes the `query_runs` row and its audit entry (`zeteo.query.run`, or
 * `zeteo.export.run` for an export) in one transaction, and returns the run's
 * id. The query is kept in the row only; neither holds any of the result.
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
      action:
        run.entryPoint === "export"
          ? AUDIT_EVENTS.exportRun
          : AUDIT_EVENTS.queryRun,
      resourceType: "query_run",
      resourceId: row.id,
      actorId: run.caller.userId,
      metadata: runMetadata(run, run),
      // This entry creates the run, an export's included.
      verb: "CREATE",
    });
    return row.id;
  });

/** An export about to send its first row. */
export type ExportStart = Pick<RunRecord, "caller" | "query" | "durationMs"> & {
  sourceId: string;
};

/**
 * Writes an export's run as `running`, with its `zeteo.export.started` audit
 * entry, in one transaction, and returns the run's id.
 */
export const recordExportStart = (run: ExportStart): Promise<string> =>
  withAudit(async (tx, audit) => {
    const row = await tx.queryRun.create({
      data: {
        userId: run.caller.userId,
        sourceId: run.sourceId,
        entryPoint: "export",
        query: run.query as Prisma.InputJsonValue,
        durationMs: run.durationMs,
        rowCount: null,
        outcome: "running",
        errorCode: null,
        truncated: false,
      },
      select: { id: true },
    });
    audit({
      action: AUDIT_EVENTS.exportStarted,
      resourceType: "query_run",
      resourceId: row.id,
      actorId: run.caller.userId,
      metadata: { source_id: run.sourceId, entry_point: "export" },
    });
    return row.id;
  });

/** How an export ended. */
export type ExportEnd = Pick<
  RunRecord,
  "durationMs" | "outcome" | "errorCode" | "truncated"
> & { rowCount: number | null };

/**
 * Closes an export's run with how it ended, and writes `zeteo.export.run`, in
 * one transaction, only while the run is still `running`: a run something
 * else has already closed is left as it is, with no second entry. Resolves
 * whether it closed the run.
 */
export const recordExportEnd = (
  runId: string,
  run: Pick<ExportStart, "sourceId"> & { caller: Pick<Caller, "userId"> },
  end: ExportEnd
): Promise<boolean> =>
  withAudit(async (tx, audit) => {
    const { count } = await tx.queryRun.updateMany({
      where: { id: runId, outcome: "running" },
      data: {
        durationMs: end.durationMs,
        rowCount: end.rowCount,
        outcome: end.outcome,
        errorCode: end.errorCode,
        truncated: end.truncated,
      },
    });
    if (count === 0) {
      logger.warn(
        { run_id: runId, source_id: run.sourceId },
        "an export's run was no longer running when it ended; left as it was"
      );
      return false;
    }
    audit({
      action: AUDIT_EVENTS.exportRun,
      resourceType: "query_run",
      resourceId: runId,
      actorId: run.caller.userId,
      metadata: runMetadata(
        { sourceId: run.sourceId, entryPoint: "export" },
        end
      ),
    });
    return true;
  });

/**
 * Closes an export whose process died: `failed` with `interrupted`, its row
 * count kept, its duration the time since it started (never more than the
 * export limit). It goes through `recordExportEnd`, so an export ending at
 * this moment and this call cannot both write.
 */
export const recordInterruptedExport = (
  row: {
    id: string;
    userId: string;
    sourceId: string;
    rowCount: number | null;
    createdAt: Date;
  },
  now: Date
): Promise<boolean> =>
  recordExportEnd(
    row.id,
    { caller: { userId: row.userId }, sourceId: row.sourceId },
    {
      durationMs: Math.min(
        Math.max(now.getTime() - row.createdAt.getTime(), 0),
        EXPORT_TIMEOUT_MS
      ),
      rowCount: row.rowCount,
      outcome: "failed",
      errorCode: "interrupted",
      truncated: false,
    }
  );
