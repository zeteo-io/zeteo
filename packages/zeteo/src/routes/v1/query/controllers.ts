import { callerOf } from "../../../middleware/auth.js";
import { runQuery } from "../../../engine/index.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";

export const postQuery = async (req: Request, res: Response) => {
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
    const result = await runQuery({
      caller: callerOf(req),
      entryPoint: "api",
      body: req.body,
      signal: abandoned.signal,
    });
    if (abandoned.signal.aborted) return;
    res.status(200).json(result);
  } catch (err) {
    if (abandoned.signal.aborted) {
      logger.info({ err }, "query abandoned by its client");
      return;
    }
    throw err;
  } finally {
    res.off("close", onClose);
  }
};
