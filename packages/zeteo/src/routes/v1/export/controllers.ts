import { validateQuery } from "../../../utils/validateReq.js";
import { serveExport } from "../../../export/serveExport.js";
import { callerOf } from "../../../middleware/auth.js";
import { runExport } from "../../../engine/export.js";
import { ExportQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";

export const postExport = async (req: Request, res: Response) => {
  const { format } = validateQuery(ExportQuerySchema, req);
  await serveExport(req, res, format, (sink, signal) =>
    runExport({ caller: callerOf(req), body: req.body, signal }, sink)
  );
};
