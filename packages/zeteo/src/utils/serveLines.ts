import { acceptsGzip } from "../export/httpSink.js";
import { createGzip, type Gzip } from "node:zlib";
import type { Request, Response } from "express";
import type { Writable } from "node:stream";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";

/** Writes one line of the stream; rejects once the response has closed. */
export type EmitLine = (line: unknown) => Promise<void>;

class ResponseClosedError extends Error {
  constructor() {
    super("the response closed before the stream ended");
    this.name = "ResponseClosedError";
  }
}

/**
 * Serves `run` as an NDJSON stream: the 200 and its headers go at once,
 * gzipped when the request accepts it, then each line `run` emits, written
 * (and flushed through gzip) as soon as it is emitted, in the order emitted,
 * each waiting for the response's buffer to drain. `run` is given a signal
 * that aborts once the client goes away. A failure of `run`, or a client gone
 * before it ends, cuts the connection with no final chunk, so the client
 * knows the stream did not end; the caller writes its own last line.
 */
export const serveLines = async (
  req: Request,
  res: Response,
  run: (emit: EmitLine, signal: AbortSignal) => Promise<void>
): Promise<void> => {
  const abandoned = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      abandoned.abort(new Error("the client closed the connection"));
    }
  };
  res.on("close", onClose);

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept-Encoding");
  let out: Writable = res;
  let gzip: Gzip | undefined;
  if (acceptsGzip(req.headers["accept-encoding"])) {
    res.setHeader("Content-Encoding", "gzip");
    const zipped = createGzip();
    zipped.on("error", (err) => {
      logger.error({ err }, "gzipping a stream failed");
      res.destroy();
    });
    res.on("close", () => zipped.destroy());
    zipped.pipe(res);
    gzip = zipped;
    out = zipped;
  }
  res.flushHeaders();

  /** Settles on `event` from `from`, or rejects once the response closes or `from` fails. */
  const until = (event: "drain" | "finish", from: Writable) =>
    new Promise<void>((resolve, reject) => {
      const settle = (err?: Error) => {
        from.off(event, onEvent);
        from.off("error", onError);
        res.off("close", onResClose);
        if (err) reject(err);
        else resolve();
      };
      const onEvent = () => settle();
      const onError = (err: Error) => settle(err);
      const onResClose = () => {
        // A response that finished closes after it: nothing was lost.
        if (event === "finish" && res.writableFinished) settle();
        else settle(new ResponseClosedError());
      };
      from.on(event, onEvent);
      from.on("error", onError);
      res.on("close", onResClose);
    });

  const write = async (line: unknown): Promise<void> => {
    if (res.destroyed || out.destroyed) throw new ResponseClosedError();
    const room = out.write(`${JSON.stringify(line)}\n`);
    // Each line reaches the client as it is ready, not when gzip's block fills.
    gzip?.flush();
    if (!room) await until("drain", out);
  };
  // Lines are written one after another, whoever emits them.
  let written: Promise<void> = Promise.resolve();
  const emit: EmitLine = (line) => {
    const next = written.then(() => write(line));
    written = next.catch(() => undefined);
    return next;
  };

  try {
    await run(emit, abandoned.signal);
    await written;
    if (res.destroyed) throw new ResponseClosedError();
    const finished = until("finish", res);
    // Ending the gzip stream ends the response through the pipe.
    out.end();
    await finished;
  } catch (err) {
    res.destroy();
    if (abandoned.signal.aborted) {
      logger.info({ err }, "stream abandoned by its client");
    } else if (err instanceof AppError && err.statusCode < 500) {
      logger.warn({ err }, "stream stopped");
    } else {
      logger.error({ err }, "stream failed");
    }
  } finally {
    res.off("close", onClose);
  }
};
