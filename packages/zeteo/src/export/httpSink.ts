import { ndjsonHead, ndjsonRow, ndjsonTail } from "./ndjson.js";
import type { ColumnType } from "../adapters/types.js";
import type { ExportSink } from "../engine/export.js";
import { createGzip, type Gzip } from "node:zlib";
import type { Request, Response } from "express";
import { csvHeader, csvRow } from "./csv.js";
import type { Writable } from "node:stream";
import { logger } from "../utils/logger.js";

export type ExportFormat = "ndjson" | "csv";

const CONTENT_TYPES: Record<ExportFormat, string> = {
  ndjson: "application/x-ndjson",
  csv: "text/csv; charset=utf-8",
};

const STATUS_TRAILER = "X-Zeteo-Export-Status";
const ROWS_TRAILER = "X-Zeteo-Export-Rows";

// An RFC 9110 qvalue: 0 to 1, at most three decimals.
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Whether an `Accept-Encoding` header accepts gzip: `gzip` with a q above 0,
 * or, when gzip is not named, `*` with a q above 0. A malformed q counts as 0.
 */
export const acceptsGzip = (header: string | undefined): boolean => {
  if (!header) return false;
  let gzip: number | undefined;
  let any: number | undefined;
  for (const entry of header.split(",")) {
    const [coding = "", ...params] = entry.split(";").map((p) => p.trim());
    let q = 1;
    for (const param of params) {
      const eq = param.indexOf("=");
      if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const value = param.slice(eq + 1).trim();
      q = QVALUE.test(value) ? Number(value) : 0;
    }
    const name = coding.toLowerCase();
    if (name === "gzip") gzip = q;
    else if (name === "*") any = q;
  }
  return (gzip ?? any ?? 0) > 0;
};

/**
 * The most bytes the export sinks of this process have held unsent at once:
 * the response's buffer and, when gzipped, the gzip stream's. For tests.
 */
let highWater = 0;
export const bufferedBytes = {
  highWater: (): number => highWater,
  reset: (): void => {
    highWater = 0;
  },
};

class ResponseClosedError extends Error {
  constructor() {
    super("the response closed before the export ended");
    this.name = "ResponseClosedError";
  }
}

/**
 * A sink writing an export to `res` as NDJSON or CSV, gzipped when the
 * request accepts it. Nothing is written or set before `start`, so a refusal
 * before it is an ordinary error response. Each batch is written whole and
 * the next waits until the response (or gzip) buffer has drained. A CSV
 * export ends with its status and row count as HTTP trailers, NDJSON in its
 * last line. Every call rejects once the response has closed.
 */
export const httpSink = (
  req: Request,
  res: Response,
  format: ExportFormat
): ExportSink => {
  let out: Writable = res;
  let gzip: Gzip | undefined;
  let columns: { type: ColumnType }[] = [];

  const measure = () => {
    const held =
      res.writableLength +
      (gzip ? gzip.writableLength + gzip.readableLength : 0);
    if (held > highWater) highWater = held;
  };

  /** Settles on `event` from `out`, or rejects once the response closes or `out` fails. */
  const until = (event: "drain" | "finish", from: Writable) =>
    new Promise<void>((resolve, reject) => {
      const settle = (err?: Error) => {
        from.off(event, onEvent);
        from.off("error", onError);
        res.off("close", onClose);
        if (err) reject(err);
        else resolve();
      };
      const onEvent = () => settle();
      const onError = (err: Error) => settle(err);
      const onClose = () => {
        // A response that finished closes after it: nothing was lost.
        if (event === "finish" && res.writableFinished) settle();
        else settle(new ResponseClosedError());
      };
      from.on(event, onEvent);
      from.on("error", onError);
      res.on("close", onClose);
    });

  const write = async (text: string): Promise<void> => {
    if (res.destroyed || out.destroyed) throw new ResponseClosedError();
    const room = out.write(text);
    measure();
    if (!room) await until("drain", out);
  };

  return {
    start: async (head) => {
      if (res.destroyed) throw new ResponseClosedError();
      columns = head.columns;
      res.status(200);
      res.setHeader("Content-Type", CONTENT_TYPES[format]);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="zeteo-export-${head.runId}.${format}"`
      );
      res.setHeader("X-Zeteo-Run-Id", head.runId);
      res.setHeader("Vary", "Accept-Encoding");
      if (format === "csv") {
        const codes = [...new Set(head.warnings.map((w) => w.code))];
        if (codes.length > 0)
          res.setHeader("X-Zeteo-Warnings", codes.join(","));
        // Trailers travel only in a chunked body, which a response without a
        // Content-Length is; they are declared before the first byte.
        res.setHeader("Trailer", `${STATUS_TRAILER}, ${ROWS_TRAILER}`);
      }
      if (acceptsGzip(req.headers["accept-encoding"])) {
        res.setHeader("Content-Encoding", "gzip");
        const zipped = createGzip();
        zipped.on("error", (err) => {
          logger.error({ err }, "gzipping an export failed");
          res.destroy();
        });
        res.on("close", () => zipped.destroy());
        zipped.pipe(res);
        gzip = zipped;
        out = zipped;
      }
      // The status and headers go now, before the first row is read.
      res.flushHeaders();
      await write(
        format === "csv" ? csvHeader(head.columns) : ndjsonHead(head)
      );
    },

    rows: async (batch) => {
      let text = "";
      for (const row of batch) {
        text += format === "csv" ? csvRow(row, columns) : ndjsonRow(row);
      }
      await write(text);
    },

    end: async (tail) => {
      if (format === "ndjson") await write(ndjsonTail(tail));
      else {
        res.addTrailers({
          [STATUS_TRAILER]: tail.status,
          [ROWS_TRAILER]: String(tail.rows),
        });
      }
      if (res.destroyed) throw new ResponseClosedError();
      const finished = until("finish", res);
      // Ending the gzip stream ends the response through the pipe.
      out.end();
      await finished;
    },
  };
};
