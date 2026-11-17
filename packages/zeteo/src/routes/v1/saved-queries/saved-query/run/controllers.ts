import { savedQueryToRun } from "../../../../../saved-queries/service.js";
import { serveQuery } from "../../../../../utils/serveQuery.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { runQuery } from "../../../../../engine/index.js";
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
  await serveQuery(req, res, (signal) =>
    runQuery({ caller, entryPoint: "api", body, savedQuery, signal })
  );
};
