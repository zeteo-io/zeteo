import { callerOf } from "../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../schemas.js";
import { CreateMeasureSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  createMeasure,
  listMeasures,
} from "../../../../../measures/service.js";

export const getMeasures = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  res.status(200).json({ data: await listMeasures(callerOf(req), sourceId) });
};

export const postMeasure = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(CreateMeasureSchema, req);
  res.status(201).json(await createMeasure(callerOf(req), sourceId, body));
};
