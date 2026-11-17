import type { RunQueryResult } from "../engine/index.js";
import type { Request, Response } from "express";
import { logger } from "./logger.js";

/**
 * Serves one query run on the response: `run` is given a signal that aborts
 * once the client goes away, so the run is stopped on the source. Its result
 * is the 200; its error goes to the error handler, unless the client has gone,
 * when nothing can be written and the error is only logged.
 */
export const serveQuery = async (
  _req: Request,
  res: Response,
  run: (signal: AbortSignal) => Promise<RunQueryResult>
): Promise<void> => {
  // Fires once the connection closes before the response has been sent: the
  // client went away, and the run is stopped on the source.
  const abandoned = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      abandoned.abort(new Error("the client closed the connection"));
    }
  };
  res.on("close", onClose);
  try {
    const result = await run(abandoned.signal);
    if (abandoned.signal.aborted) return;
    res.status(200).json(result);
  } catch (err) {
    if (abandoned.signal.aborted) {
      // Nothing can be written to the closed response; an error other than
      // the abort itself still needs looking at.
      if (err === abandoned.signal.reason) {
        logger.info({ err }, "query abandoned by its client");
      } else {
        logger.error({ err }, "query failed after its client went away");
      }
      return;
    }
    throw err;
  } finally {
    res.off("close", onClose);
  }
};
