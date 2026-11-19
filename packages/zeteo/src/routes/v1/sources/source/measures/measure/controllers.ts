import { MeasureParamsSchema, UpdateMeasureSchema } from "./schemas.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  deleteMeasure as remove,
  getMeasure as get,
  updateMeasure,
} from "../../../../../../measures/service.js";

export const getMeasure = async (req: Request, res: Response) => {
  const { sourceId, measureId } = validateParams(MeasureParamsSchema, req);
  res.status(200).json(await get(callerOf(req), sourceId, measureId));
};

export const patchMeasure = async (req: Request, res: Response) => {
  const { sourceId, measureId } = validateParams(MeasureParamsSchema, req);
  const body = validateBody(UpdateMeasureSchema, req);
  res
    .status(200)
    .json(await updateMeasure(callerOf(req), sourceId, measureId, body));
};

export const deleteMeasure = async (req: Request, res: Response) => {
  const { sourceId, measureId } = validateParams(MeasureParamsSchema, req);
  await remove(callerOf(req), sourceId, measureId);
  res.status(204).end();
};
