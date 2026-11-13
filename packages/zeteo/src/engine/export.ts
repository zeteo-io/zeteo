import { ExportNotEnabledError, QueryTimeoutError } from "../utils/errors.js";
import type { ColumnType, QueryWarning } from "../adapters/types.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { withSourceConnection } from "../sources/pools.js";
import { approxRowBytes } from "../adapters/rowSize.js";
import { loadUserLimits } from "../limits/resolve.js";
import type { Caller } from "../middleware/auth.js";
import { performance } from "node:perf_hooks";
import { nextBatchRows } from "./collect.js";
import { logger } from "../utils/logger.js";
import { QueryError } from "./errors.js";
import {
  CLIENT_CLOSED,
  failureOf,
  recordExportEnd,
  recordExportStart,
  UNRECORDABLE_QUERY,
  type ExportEnd,
  type ExportStart,
} from "./record.js";
import {
  acquireExportLeases,
  type UserLimits,
  EXPORT_LEASE_MS,
  EXPORT_LEASE_RENEW_MS,
  EXPORT_TIMEOUT_MS,
} from "./limits.js";
import {
  checkColumns,
  checkRows,
  loadCatalogFor,
  planFor,
  recordRunOrPlaceholder,
  sourceSlugOf,
  type Progress,
} from "./index.js";

/** Where an export's rows go: the response, in whatever format it writes. */
export interface ExportSink {
  /** Called once, after the run is recorded as started and before any row. */
  start(head: {
    columns: { name: string; type: ColumnType }[];
    warnings: QueryWarning[];
    runId: string;
  }): Promise<void>;
  /** Resolves when the sink can take more. */
  rows(batch: unknown[][]): Promise<void>;
  end(tail: { status: "complete" | "truncated"; rows: number }): Promise<void>;
}

export interface RunExportInput {
  caller: Caller;
  /** The query as the caller sent it. */
  body: unknown;
  /** Aborts when the caller goes away: the export is stopped on the source. */
  signal: AbortSignal;
  /** The caller's concurrency limits; read for the caller as the export starts when absent. */
  userLimits?: UserLimits;
}

/** Why an export was stopped before it ended, and what it rejects with. */
type Halt =
  | { why: "client_closed" | "sink"; err: unknown }
  | { why: "shutting_down"; err: ServiceUnavailableError }
  | { why: "timeout"; err: QueryTimeoutError };

/** The reason a stream is stopped with when the export no longer needs its rows. */
const ENDED_EARLY = new Error("the export needs no more rows");

const SHUTDOWN_CODE = "shutting_down";

/** Every running export in this process, by how to stop it. */
const running = new Set<(halt: Halt) => void>();

/** Set once the process stops: no new export starts. */
let shuttingDown = false;
/** The errors shutdown stopped or refused exports with. */
const shutdownErrors = new WeakSet<object>();

const shutdownError = (): ServiceUnavailableError => {
  const err = new ServiceUnavailableError("The service is shutting down");
  shutdownErrors.add(err);
  return err;
};

/** Whether `err` is what an export stopped or refused by shutdown rejects with. */
export const isExportShutdown = (err: unknown): boolean =>
  typeof err === "object" && err !== null && shutdownErrors.has(err);

/**
 * Aborts every running export in this process with a `shutting_down` reason,
 * and refuses every later one.
 */
export const abortExports = (): void => {
  shuttingDown = true;
  for (const halt of running) {
    halt({ why: "shutting_down", err: shutdownError() });
  }
};

/** Lets exports start again after `abortExports`; for tests. */
export const resetExportShutdown = (): void => {
  shuttingDown = false;
};

/** A failure after the start: never `refused`, as the export was accepted. */
const failureAfterStart = (
  err: unknown
): Pick<ExportEnd, "outcome" | "errorCode"> => {
  const failure = failureOf(err);
  return failure.outcome === "refused"
    ? { outcome: "failed", errorCode: failure.errorCode }
    : failure;
};

/** How a stopped export is recorded: from why it was stopped, not from what the stream rejected with. */
const failureOfHalt = (
  halt: Halt
): Pick<ExportEnd, "outcome" | "errorCode"> => {
  switch (halt.why) {
    case "client_closed":
      return { outcome: "failed", errorCode: CLIENT_CLOSED };
    case "shutting_down":
      return { outcome: "failed", errorCode: SHUTDOWN_CODE };
    case "timeout":
      return { outcome: "timeout", errorCode: halt.err.code };
    case "sink":
      return failureAfterStart(halt.err);
  }
};

/**
 * Records the start; when the row cannot be stored, records it again with a
 * placeholder for the query. Throws only when both attempts fail.
 */
const recordStart = async (start: ExportStart): Promise<string> => {
  try {
    return await recordExportStart(start);
  } catch (err) {
    logger.error(
      { err, source_id: start.sourceId },
      "recording an export's start failed; recording it without its query"
    );
    return recordExportStart({ ...start, query: UNRECORDABLE_QUERY });
  }
};

/** Records the end; a failure is logged, and the run is left `running` for the sweep. */
const recordEnd = async (
  runId: string,
  start: ExportStart,
  end: ExportEnd
): Promise<void> => {
  try {
    await recordExportEnd(runId, start, end);
  } catch (err) {
    logger.error(
      { err, run_id: runId, source_id: start.sourceId },
      "recording an export's end failed"
    );
  }
};

/**
 * Runs one export: checks its shape, and refuses it, unrecorded, once
 * `abortExports` has been called; resolves its source and plans it against
 * what the caller may see, as a query; refuses it unless the source allows
 * exports, and refuses an offset without an `orderBy`; takes the export
 * leases and opens the run on the source, unsorted unless the query names an
 * order (the plan's `defaultOrder`); records it as started, then passes its
 * rows to `sink` in batches sized by bytes as a query's are (`nextBatchRows`
 * over `approxRowBytes`), up to the source's export cap, and records how it
 * ended.
 *
 * Rejects before `sink.start` for anything refused, recorded as a query's
 * refusal is. After it, a rejection means the stream must be cut: the export
 * is recorded as failed (`client_closed`, `shutting_down` or the error's
 * code) or as a timeout. The time limit covers the whole export, time the
 * sink takes to accept rows included. `options.timeoutMs` shortens it, for
 * tests.
 */
export const runExport = async (
  input: RunExportInput,
  sink: ExportSink,
  options: { timeoutMs?: number } = {}
): Promise<void> => {
  const slug = sourceSlugOf(input.body);
  // Not recorded: the service is stopping, not refusing the export.
  if (shuttingDown) throw shutdownError();
  const began = performance.now();
  const elapsed = () => Math.round(performance.now() - began);
  const timeoutMs = options.timeoutMs ?? EXPORT_TIMEOUT_MS;
  const progress: Progress = { sourceId: null, unrecorded: false };

  // The run's own signal: the caller's, the deadline and shutdown each abort
  // it, and so does an export that ends early, before its stream is closed.
  const controller = new AbortController();
  let halted: Halt | undefined;
  let rejectHalted!: (err: unknown) => void;
  const whenHalted = new Promise<never>((_, reject) => {
    rejectHalted = reject;
  });
  whenHalted.catch(() => undefined);
  const halt = (reason: Halt): void => {
    if (halted) return;
    halted = reason;
    rejectHalted(reason.err);
    if (!controller.signal.aborted) controller.abort(reason.err);
  };
  /** `step`, or the halt's error as soon as the export is halted. */
  const untilHalted = <T>(step: Promise<T>): Promise<T> =>
    Promise.race([step, whenHalted]);
  /**
   * A call on the sink, made only while the export is not halted, so a
   * halted export never tells its reader it started or ended. Its failure
   * halts the export.
   */
  const toSink = (call: () => Promise<void>): Promise<void> => {
    if (halted) return Promise.reject(halted.err);
    let pending: Promise<void>;
    try {
      pending = call();
    } catch (err) {
      halt({ why: "sink", err });
      return Promise.reject(err);
    }
    return untilHalted(
      pending.catch((err: unknown) => {
        halt({ why: "sink", err });
        throw err;
      })
    );
  };

  const onCallerAbort = () =>
    halt({ why: "client_closed", err: input.signal.reason });
  input.signal.addEventListener("abort", onCallerAbort, { once: true });
  if (input.signal.aborted) onCallerAbort();
  running.add(halt);

  let deadline: NodeJS.Timeout | undefined;
  let start: ExportStart | undefined;
  let runId: string | undefined;
  /** Rows handed to the sink. */
  let sent = 0;
  /** Rows read from the stream and their bytes, which size the next batch. */
  const read = { rows: 0, bytes: 0 };
  try {
    const { access, catalog } = await loadCatalogFor(
      input.caller,
      slug,
      progress
    );
    const { source } = catalog;
    if (!source.exportEnabled || source.exportRowCap === 0) {
      throw new ExportNotEnabledError();
    }
    const { adapter, plan } = planFor(input.body, access, catalog, progress);
    // An export has no default order (sorting everything would hold back
    // its first row), so an offset with no orderBy would skip arbitrary rows.
    if (plan.offset > 0 && plan.defaultOrder === true) {
      throw new QueryError(
        "invalid_order",
        "An export with an offset needs an orderBy",
        ["offset"]
      );
    }
    const ownLimits = input.userLimits ?? (await loadUserLimits(access));
    const cap = Math.min(
      plan.limit ?? source.exportRowCap,
      source.exportRowCap
    );
    // One more row than the cap tells a capped export from a complete one.
    const prepared = adapter.prepare(plan, {
      limit: cap + 1,
      offset: plan.offset,
      defaultOrder: false,
    });

    const deadlineAt = performance.now() + timeoutMs;
    deadline = setTimeout(
      () => halt({ why: "timeout", err: new QueryTimeoutError() }),
      timeoutMs
    );
    controller.signal.throwIfAborted();
    const leases = await acquireExportLeases(
      input.caller.userId,
      source,
      EXPORT_LEASE_MS,
      ownLimits
    );
    const renewal = setInterval(
      () => void leases.renew(EXPORT_LEASE_MS),
      EXPORT_LEASE_RENEW_MS
    );
    let tail: Parameters<ExportSink["end"]>[0];
    try {
      tail = await withSourceConnection(source.id, async (conn) => {
        const stream = await conn.openQuery(
          prepared,
          { deadlineAt, timeoutMs },
          controller.signal
        );
        let drained = false;
        try {
          checkColumns(plan, stream.columns, source.id);
          start = {
            caller: input.caller,
            sourceId: source.id,
            query: input.body,
            durationMs: elapsed(),
          };
          runId = await recordStart(start);
          const head = {
            columns: stream.columns,
            warnings: plan.warnings,
            runId,
          };
          await toSink(() => sink.start(head));
          for (;;) {
            const batch = await untilHalted(
              stream.next(Math.min(nextBatchRows(read), cap + 1 - sent))
            );
            if (batch.length === 0) {
              drained = true;
              return { status: "complete" as const, rows: sent };
            }
            read.rows += batch.length;
            for (const row of batch) read.bytes += approxRowBytes(row);
            checkRows(plan, stream.columns, batch, source.id);
            const room = cap - sent;
            const kept = batch.length > room ? batch.slice(0, room) : batch;
            if (kept.length > 0) {
              sent += kept.length;
              await toSink(() => sink.rows(kept));
            }
            if (batch.length > room) {
              return { status: "truncated" as const, rows: sent };
            }
          }
        } finally {
          // A read in flight when the stream is closed would be reported as
          // a failure of its own; stopped first, it ends as this run's stop.
          if (!drained && !controller.signal.aborted) {
            controller.abort(ENDED_EARLY);
          }
          await stream.close();
        }
      });
    } finally {
      clearInterval(renewal);
      // Not waited for: a release that fails is logged, and its lease lapses.
      void leases.release();
    }
    // Recorded `ok` only once the reader has taken the end; a halt before
    // it ends the export unended, recorded as halted.
    await toSink(() => sink.end(tail));
    await recordEnd(runId!, start!, {
      durationMs: elapsed(),
      rowCount: sent,
      outcome: "ok",
      errorCode: null,
      truncated: tail.status === "truncated",
    });
  } catch (err) {
    const thrown = halted ? halted.err : err;
    if (runId !== undefined && start !== undefined) {
      await recordEnd(runId, start, {
        durationMs: elapsed(),
        rowCount: sent,
        truncated: false,
        ...(halted ? failureOfHalt(halted) : failureAfterStart(err)),
      });
      throw thrown;
    }
    if (progress.unrecorded) throw err;
    try {
      await recordRunOrPlaceholder({
        caller: input.caller,
        sourceId: progress.sourceId,
        entryPoint: "export",
        query: input.body,
        durationMs: elapsed(),
        rowCount: null,
        truncated: false,
        ...(halted ? failureOfHalt(halted) : failureOf(err)),
      });
    } catch (recordErr) {
      logger.error(
        { err: recordErr, source_id: progress.sourceId },
        "a refused or failed export could not be recorded, even without its query"
      );
    }
    throw thrown;
  } finally {
    clearTimeout(deadline);
    running.delete(halt);
    input.signal.removeEventListener("abort", onCallerAbort);
  }
};
