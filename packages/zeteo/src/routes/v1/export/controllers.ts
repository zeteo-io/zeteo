import { isExportShutdown, runExport } from "../../../engine/export.js";
import { AppError, QueryTimeoutError } from "../../../utils/errors.js";
import { validateQuery } from "../../../utils/validateReq.js";
import type { ExportSink } from "../../../engine/export.js";
import { httpSink } from "../../../export/httpSink.js";
import { callerOf } from "../../../middleware/auth.js";
import { logger } from "../../../utils/logger.js";
import { ExportQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";

export const postExport = async (req: Request, res: Response) => {
  const { format } = validateQuery(ExportQuerySchema, req);
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
    await runExport(
      { caller: callerOf(req), body: req.body, signal: abandoned.signal },
      watched
    );
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
