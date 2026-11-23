import { header, isObject, sendRaw, type CallContext } from "../send.js";
import { ExportInterruptedError, ZeteoError } from "../errors.js";
import type { Query, QueryWarning } from "../types/query.js";
import { LineTooLongError, lines } from "../ndjson.js";
import type { ColumnType } from "../types/common.js";
import type { DianemoResponse } from "@dianemo/core";
import type { OperationId } from "../operations.js";
import type { Readable } from "node:stream";

export interface ExportEnd {
  status: "complete" | "truncated";
  rows: number;
}

export interface ExportRows {
  runId: string;
  /**
   * True when a row rule of the caller's limits the rows of a table the query
   * reads (the response's `X-Zeteo-Rows-Limited`): the export holds only the
   * rows the caller may see.
   */
  rowsLimited: boolean;
  columns: { name: string; type: ColumnType }[];
  warnings: QueryWarning[];
  /**
   * Readable once. Throws `ExportInterruptedError` unless the stream reached
   * its end line. The connection is held until `rows` is read to its end, left
   * early (`break`, `return()`), or the call's `signal` aborts. Reading has no
   * time limit of its own: only `signal` bounds it.
   */
  rows: AsyncIterable<unknown[]>;
  /**
   * Resolves with the end line; rejects with the iterator's
   * `ExportInterruptedError`. Settles only once `rows` is read or released.
   */
  done: Promise<ExportEnd>;
}

export interface ExportStream {
  runId: string;
  /**
   * True when a row rule of the caller's limits the rows of a table the query
   * reads (the response's `X-Zeteo-Rows-Limited`): the export holds only the
   * rows the caller may see.
   */
  rowsLimited: boolean;
  /**
   * The connection is held until `stream` is read to its end or destroyed;
   * only the call's `signal` bounds it. Completeness is the caller's to check.
   */
  stream: Readable;
}

/** @internal For tests: a smaller line cap. */
export interface ExportInternals {
  maxLineBytes?: number;
}

const runIdHeader = (response: DianemoResponse): string | undefined =>
  header(response.headers, "x-zeteo-run-id") || undefined;

const rowsLimitedHeader = (response: DianemoResponse): boolean =>
  header(response.headers, "x-zeteo-rows-limited")?.toLowerCase() === "true";

/** What an export call sends: its operation, path parameters and body. */
export interface ExportTarget {
  op: OperationId;
  params?: Record<string, string>;
  body?: unknown;
}

interface Opened {
  runId: string;
  rowsLimited: boolean;
  body: Readable;
}

// Axios has already removed a gzip Content-Encoding it decoded.
async function open(
  ctx: CallContext,
  target: ExportTarget,
  format: "ndjson" | "csv",
  signal?: AbortSignal
): Promise<Opened> {
  const response = (await sendRaw(ctx, {
    op: target.op,
    params: target.params,
    query: { format },
    body: target.body,
    once: true,
    stream: true,
    signal,
    headers: { "Accept-Encoding": "gzip" },
  })) as DianemoResponse<Readable>;
  const runId = runIdHeader(response);
  if (runId === undefined) {
    response.data.destroy();
    throw new ZeteoError(
      "@zeteo-io/sdk: the export response carried no run id",
      {
        status: response.status,
        code: "invalid_response",
      }
    );
  }
  return {
    runId,
    rowsLimited: rowsLimitedHeader(response),
    body: response.data,
  };
}

// What the end line is given to settle: time for the response's last chunk,
// without letting a server that holds the response open hold the reader.
const END_GRACE_MS = 100;

async function readRows(
  opened: Opened,
  signal: AbortSignal | undefined,
  maxLineBytes: number | undefined
): Promise<ExportRows> {
  const { body } = opened;
  let runId = opened.runId;
  let rowsRead = 0;
  let failure: ExportInterruptedError | undefined;
  let finished = false;
  let resolveDone!: (end: ExportEnd) => void;
  let rejectDone!: (error: ExportInterruptedError) => void;
  const done = new Promise<ExportEnd>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => undefined);

  const source = lines(body, maxLineBytes);
  const fail = (message: string): ExportInterruptedError => {
    if (!failure) {
      failure = new ExportInterruptedError(
        `@zeteo-io/sdk: ${message}`,
        runId,
        rowsRead
      );
      rejectDone(failure);
    }
    body.destroy();
    void source.return(undefined).catch(() => undefined);
    return failure;
  };
  const aborted = "the export was aborted by the caller";
  const cut = "the export connection was cut";
  // A cut while no one is reading still settles `done`.
  body.on("error", () => {
    if (!finished) fail(signal?.aborted ? aborted : cut);
  });

  // Lines already decoded from a chunk are still handed out after the stream
  // failed; none of them may reach the reader.
  const next = async (): Promise<IteratorResult<unknown>> => {
    let result: IteratorResult<unknown>;
    try {
      result = await source.next();
    } catch (error) {
      throw (
        failure ??
        fail(
          signal?.aborted
            ? aborted
            : error instanceof LineTooLongError
              ? "an export line exceeded the size limit"
              : error instanceof SyntaxError
                ? "an export line was not valid JSON"
                : cut
        )
      );
    }
    if (signal?.aborted) throw fail(aborted);
    if (failure) throw failure;
    return result;
  };

  const first = await next();
  const head = first.done ? undefined : first.value;
  if (
    !isObject(head) ||
    typeof head.run_id !== "string" ||
    !Array.isArray(head.columns) ||
    !Array.isArray(head.warnings)
  ) {
    throw fail(
      first.done
        ? "the export stream ended before its head"
        : "the export stream's first line is not its head"
    );
  }
  runId = head.run_id;

  const finish = async (end: ExportEnd): Promise<void> => {
    finished = true;
    resolveDone(end);
    let timer: NodeJS.Timeout | undefined;
    const drained = (async () => {
      try {
        while (!(await source.next()).done);
      } catch {
        // Every row and the end line have arrived.
      }
    })();
    await Promise.race([
      drained,
      new Promise((ok) => (timer = setTimeout(ok, END_GRACE_MS))),
    ]);
    clearTimeout(timer);
    body.destroy();
  };

  const release = () => {
    if (!finished) fail("the export was stopped by its reader before its end");
  };

  async function* read(): AsyncGenerator<unknown[]> {
    try {
      for (;;) {
        const result = await next();
        if (result.done) {
          throw fail("the export stream ended without its end line");
        }
        const value = result.value;
        if (Array.isArray(value)) {
          rowsRead += 1;
          yield value;
          continue;
        }
        if (
          isObject(value) &&
          (value.status === "complete" || value.status === "truncated") &&
          typeof value.rows === "number"
        ) {
          if (value.rows !== rowsRead) {
            throw fail(
              `the export's end line counts ${value.rows} rows, but ${rowsRead} arrived`
            );
          }
          await finish({ status: value.status, rows: value.rows });
          return;
        }
        throw fail(
          "the export stream held a line that is neither a row nor its end"
        );
      }
    } finally {
      release();
    }
  }

  let used = false;
  return {
    runId,
    rowsLimited: opened.rowsLimited,
    columns: head.columns as ExportRows["columns"],
    warnings: head.warnings as QueryWarning[],
    rows: {
      [Symbol.asyncIterator]() {
        if (used) {
          throw new Error("@zeteo-io/sdk: export rows can be read only once");
        }
        used = true;
        const generator = read();
        // `return()` or `throw()` on a generator that never started skips its
        // `finally`.
        return {
          next: () => generator.next(),
          return: (value?: unknown) => {
            release();
            return generator.return(value as undefined);
          },
          throw: (error?: unknown) => {
            release();
            return generator.throw(error);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    },
    done,
  };
}

/**
 * The streaming reads of one kind of export: `subject` says what is exported
 * (a query, or a saved query), `target` how it is sent. A saved query's export
 * reads exactly as a query's does.
 */
export const exportMethods = <S>(
  ctx: CallContext,
  target: (subject: S) => ExportTarget,
  internals: ExportInternals = {}
) => ({
  // Never repeated: an export is long, and zeteo records each run.
  /**
   * Resolves once the stream's first line has arrived; while waiting for it
   * only the `signal` bounds the call.
   */
  rows: async (
    subject: S,
    options?: { signal?: AbortSignal }
  ): Promise<ExportRows> =>
    readRows(
      await open(ctx, target(subject), "ndjson", options?.signal),
      options?.signal,
      internals.maxLineBytes
    ),

  stream: async (
    subject: S,
    options?: { format?: "ndjson" | "csv"; signal?: AbortSignal }
  ): Promise<ExportStream> => {
    const { runId, rowsLimited, body } = await open(
      ctx,
      target(subject),
      options?.format ?? "ndjson",
      options?.signal
    );
    return { runId, rowsLimited, stream: body };
  },
});

export const exportCalls = (
  ctx: CallContext,
  internals: ExportInternals = {}
) =>
  exportMethods(
    ctx,
    (query: Query): ExportTarget => ({ op: "exportQuery", body: query }),
    internals
  );
