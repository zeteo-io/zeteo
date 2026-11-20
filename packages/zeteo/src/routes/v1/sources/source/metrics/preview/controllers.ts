import { previewMetric as preview } from "../../../../../../measures/metrics.js";
import { serveQuery } from "../../../../../../utils/serveQuery.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../../schemas.js";
import { PreviewMetricSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const previewMetric = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const { metric, bucket, range } = validateBody(PreviewMetricSchema, req);
  const caller = callerOf(req);
  await serveQuery(req, res, (signal) =>
    preview(caller, sourceId, metric, { bucket, range }, signal)
  );
};
