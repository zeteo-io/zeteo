import type { Query, QueryWarning } from "../types/query.js";
import { sendRaw, type CallContext } from "../send.js";
import { ExportInterruptedError } from "../errors.js";
import type { ColumnType } from "../types/common.js";
import type { DianemoResponse } from "@dianemo/core";
import type { Readable } from "node:stream";
import { lines } from "../ndjson.js";

export interface ExportEnd {
  status: "complete" | "truncated";
  rows: number;
}

export interface ExportRows {
  runId: string;
  columns: { name: string; type: ColumnType }[];
  warnings: QueryWarning[];
  /** Readable once. Throws `ExportInterruptedError` unless the stream reached its end line. */
  rows: AsyncIterable<unknown[]>;
  /** Resolves with the end line; rejects with the iterator's `ExportInterruptedError`. */
  done: Promise<ExportEnd>;
}

export interface ExportStream {
  runId: string;
  stream: Readable;
}

type Body = Record<string, unknown>;

const isObject = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runIdHeader = (response: DianemoResponse): string => {
  const headers = response.headers as
    { get?: (n: string) => unknown; [k: string]: unknown } | undefined;
  const value =
    typeof headers?.get === "function"
      ? headers.get("x-zeteo-run-id")
      : headers?.["x-zeteo-run-id"];
  return typeof value === "string" ? value : "";
};

// Axios has already removed a gzip Content-Encoding it decoded.
const open = (
  ctx: CallContext,
  query: Query,
  format: "ndjson" | "csv",
  signal?: AbortSignal
): Promise<DianemoResponse<Readable>> =>
  sendRaw(ctx, {
    op: "exportQuery",
    query: { format },
    body: query,
    once: true,
    stream: true,
    signal,
    headers: { "Accept-Encoding": "gzip" },
  }) as Promise<DianemoResponse<Readable>>;

async function readRows(
  response: DianemoResponse<Readable>
): Promise<ExportRows> {
  const body = response.data;
  let runId = runIdHeader(response);
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
    return failure;
  };
  // A cut while no one is reading still settles `done`.
  body.on("error", () => {
    if (!finished) fail("the export stream was cut");
  });

  const source = lines(body);
  const next = async (): Promise<IteratorResult<unknown>> => {
    try {
      return await source.next();
    } catch {
      throw (
        failure ??
        fail("the export stream was cut or held a line that is not JSON")
      );
    }
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
        : "the export stream's head is not one"
    );
  }
  runId = head.run_id;

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
          finished = true;
          resolveDone({ status: value.status, rows: value.rows });
          // Taking the rest lets zeteo see the end was received.
          try {
            while (!(await source.next()).done);
          } catch {
            // Every row and the end line have arrived.
          }
          return;
        }
        throw fail(
          "the export stream held a line that is neither a row nor its end"
        );
      }
    } finally {
      if (!finished) {
        fail("the export was stopped before its end line");
        void source.return(undefined).catch(() => undefined);
      }
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
        return read();
      },
    },
    done,
  };
}

export const exportCalls = (ctx: CallContext) => ({
  // Never repeated: an export is long, and zeteo records each run.
  rows: async (
    query: Query,
    options?: { signal?: AbortSignal }
  ): Promise<ExportRows> =>
    readRows(await open(ctx, query, "ndjson", options?.signal)),

  stream: async (
    query: Query,
    options?: { format?: "ndjson" | "csv"; signal?: AbortSignal }
  ): Promise<ExportStream> => {
    const response = await open(
      ctx,
      query,
      options?.format ?? "ndjson",
      options?.signal
    );
    return { runId: runIdHeader(response), stream: response.data };
  },
});
