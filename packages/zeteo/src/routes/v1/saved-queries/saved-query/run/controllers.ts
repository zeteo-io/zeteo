import { savedQueryToRun } from "../../../../../saved-queries/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { runQuery } from "../../../../../engine/index.js";
import { logger } from "../../../../../utils/logger.js";
import { SavedQueryParamsSchema } from "../schemas.js";
import { RunSavedQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const runSavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  const paging = validateBody(RunSavedQuerySchema, req);
  const caller = callerOf(req);
  const { body, savedQuery } = await savedQueryToRun(
    caller,
    savedQueryId,
    paging
  );
  // As `POST /v1/query`: once the client goes away, the run is stopped.
  const abandoned = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      abandoned.abort(new Error("the client closed the connection"));
    }
  };
  res.on("close", onClose);
  try {
    const result = await runQuery({
      caller,
      entryPoint: "api",
      body,
      savedQuery,
      signal: abandoned.signal,
    });
    if (abandoned.signal.aborted) return;
    res.status(200).json(result);
  } catch (err) {
    if (abandoned.signal.aborted) {
      // Nothing can be written to the closed response.
      if (err === abandoned.signal.reason) {
        logger.info({ err }, "saved query run abandoned by its client");
      } else {
        logger.error(
          { err },
          "saved query run failed after its client went away"
        );
      }
      return;
    }
    throw err;
  } finally {
    res.off("close", onClose);
  }
};
