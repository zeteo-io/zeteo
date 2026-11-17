import { savedQueryToRun } from "../../../../../saved-queries/service.js";
import { ExportQuerySchema, ExportSavedQuerySchema } from "./schemas.js";
import { serveExport } from "../../../../../export/serveExport.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { runExport } from "../../../../../engine/export.js";
import { SavedQueryParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";

export const exportSavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  const { format } = validateQuery(ExportQuerySchema, req);
  const paging = validateBody(ExportSavedQuerySchema, req);
  const caller = callerOf(req);
  const { body, savedQuery } = await savedQueryToRun(
    caller,
    savedQueryId,
    paging
  );
  await serveExport(req, res, format, (sink, signal) =>
    runExport({ caller, body, signal, savedQuery }, sink)
  );
};
