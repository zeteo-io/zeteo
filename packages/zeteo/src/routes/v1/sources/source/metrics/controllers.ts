import { createMetric, listMetrics } from "../../../../../measures/metrics.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../schemas.js";
import { CreateMetricSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const getMetrics = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const list = await listMetrics(callerOf(req), sourceId);
  res.status(200).json({
    data: list.items,
    can_edit: list.canEdit,
    can_manage_editors: list.canManageEditors,
  });
};

export const postMetric = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(CreateMetricSchema, req);
  res.status(201).json(await createMetric(callerOf(req), sourceId, body));
};
