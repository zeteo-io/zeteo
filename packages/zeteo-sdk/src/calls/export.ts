import { ExportInterruptedError, ZeteoError } from "../errors.js";
import type { Query, QueryWarning } from "../types/query.js";
import { sendRaw, type CallContext } from "../send.js";
import { LineTooLongError, lines } from "../ndjson.js";
import type { ColumnType } from "../types/common.js";
import type { DianemoResponse } from "@dianemo/core";
import type { Readable } from "node:stream";

export interface ExportEnd {
  status: "complete" | "truncated";
  rows: number;
}

export interface ExportRows {
  runId: string;
  columns: { name: string; type: ColumnType }[];
  warnings: QueryWarning[];
  /**
   * Readable once. Throws `ExportInterruptedError` unless the stream reached
   * its end line. The connection is held until `rows` is read to its end, left
   * early (`break`, `return()`), or the call's `signal` aborts.
   */
  rows: AsyncIterable<unknown[]>;
  /** Resolves with the end line; rejects with the iterator's `ExportInterruptedError`. */
  done: Promise<ExportEnd>;
}

export interface ExportStream {
  runId: string;
  stream: Readable;
}

/** @internal For tests: a smaller line cap. */
export interface ExportInternals {
  maxLineBytes?: number;
}

type Body = Record<string, unknown>;

const isObject = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runIdHeader = (response: DianemoResponse): string | undefined => {
  const headers = response.headers as
    { get?: (n: string) => unknown; [k: string]: unknown } | undefined;
  const value =
    typeof headers?.get === "function"
      ? headers.get("x-zeteo-run-id")
      : headers?.["x-zeteo-run-id"];
  return typeof value === "string" && value !== "" ? value : undefined;
};

// Axios has already removed a gzip Content-Encoding it decoded.
async function open(
  ctx: CallContext,
  query: Query,
  format: "ndjson" | "csv",
  signal?: AbortSignal
): Promise<{ runId: string; body: Readable }> {
  const response = (await sendRaw(ctx, {
    op: "exportQuery",
    query: { format },
    body: query,
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
  return { runId, body: response.data };
}

// What the end line is given to settle: time for the response's last chunk,
// without letting a server that holds the response open hold the reader.
const END_GRACE_MS = 100;

async function readRows(
  opened: { runId: string; body: Readable },
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

export const exportCalls = (
  ctx: CallContext,
  internals: ExportInternals = {}
) => ({
  // Never repeated: an export is long, and zeteo records each run.
  /**
   * Resolves once the stream's first line has arrived; while waiting for it
   * only the `signal` bounds the call.
   */
  rows: async (
    query: Query,
    options?: { signal?: AbortSignal }
  ): Promise<ExportRows> =>
    readRows(
      await open(ctx, query, "ndjson", options?.signal),
      options?.signal,
      internals.maxLineBytes
    ),

  stream: async (
    query: Query,
    options?: { format?: "ndjson" | "csv"; signal?: AbortSignal }
  ): Promise<ExportStream> => {
    const { runId, body } = await open(
      ctx,
      query,
      options?.format ?? "ndjson",
      options?.signal
    );
    return { runId, stream: body };
  },
});
