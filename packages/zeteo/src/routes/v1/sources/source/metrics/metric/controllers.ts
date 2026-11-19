import { MetricParamsSchema, UpdateMetricSchema } from "./schemas.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  deleteMetric as remove,
  getMetric as get,
  updateMetric,
} from "../../../../../../measures/metrics.js";

export const getMetric = async (req: Request, res: Response) => {
  const { sourceId, metricId } = validateParams(MetricParamsSchema, req);
  res.status(200).json(await get(callerOf(req), sourceId, metricId));
};

export const patchMetric = async (req: Request, res: Response) => {
  const { sourceId, metricId } = validateParams(MetricParamsSchema, req);
  const body = validateBody(UpdateMetricSchema, req);
  res
    .status(200)
    .json(await updateMetric(callerOf(req), sourceId, metricId, body));
};

export const deleteMetric = async (req: Request, res: Response) => {
  const { sourceId, metricId } = validateParams(MetricParamsSchema, req);
  await remove(callerOf(req), sourceId, metricId);
  res.status(204).end();
};
