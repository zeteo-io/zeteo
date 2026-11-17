import { AppError, QueryTimeoutError } from "../utils/errors.js";
import { httpSink, type ExportFormat } from "./httpSink.js";
import { isExportShutdown } from "../engine/export.js";
import type { ExportSink } from "../engine/export.js";
import type { Request, Response } from "express";
import { logger } from "../utils/logger.js";

/**
 * Serves one export on the response: `run` is given the sink that writes it
 * in `format`, and a signal that aborts once the client goes away. A refusal
 * before the first byte rejects, for the error handler to answer; a failure
 * after it, or once the client has gone, cuts the connection with no final
 * chunk, so the client knows the export did not end.
 */
export const serveExport = async (
  req: Request,
  res: Response,
  format: ExportFormat,
  run: (sink: ExportSink, signal: AbortSignal) => Promise<void>
): Promise<void> => {
  // Fires once the connection closes before the response has ended: the
  // client went away, and the export is stopped on the source.
  const abandoned = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      abandoned.abort(new Error("the client closed the connection"));
    }
  };
  res.on("close", onClose);

  const sink = httpSink(req, res, format);
  let runId: string | undefined;
  const watched: ExportSink = {
    ...sink,
    start: (head) => {
      runId = head.runId;
      return sink.start(head);
    },
  };
  try {
    await run(watched, abandoned.signal);
  } catch (err) {
    if (runId === undefined && !abandoned.signal.aborted) {
      // Refused before anything was written: an ordinary error response.
      throw err;
    }
    // The stream has begun, or the client has gone: no error body can follow.
    // Cutting the connection, with no final chunk, tells the client the
    // export did not end.
    res.destroy();
    const context = { err, run_id: runId };
    if (abandoned.signal.aborted && err === abandoned.signal.reason) {
      logger.info(context, "export abandoned by its client");
    } else if (
      (err instanceof AppError && err.statusCode < 500) ||
      err instanceof QueryTimeoutError ||
      isExportShutdown(err)
    ) {
      logger.warn(context, "export stopped mid-stream");
    } else {
      logger.error(context, "export failed mid-stream");
    }
  } finally {
    res.off("close", onClose);
  }
};
