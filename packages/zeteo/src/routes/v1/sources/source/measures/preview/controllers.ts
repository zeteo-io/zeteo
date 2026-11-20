import { previewMeasure as preview } from "../../../../../../measures/service.js";
import { serveQuery } from "../../../../../../utils/serveQuery.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../../schemas.js";
import { PreviewMeasureSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const previewMeasure = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(PreviewMeasureSchema, req);
  const caller = callerOf(req);
  await serveQuery(req, res, (signal) =>
    preview(caller, sourceId, body.measure, body.bucket, signal)
  );
};
