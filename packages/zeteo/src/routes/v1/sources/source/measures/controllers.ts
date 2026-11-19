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
  const list = await listMeasures(callerOf(req), sourceId);
  res.status(200).json({
    data: list.items,
    can_edit: list.canEdit,
    can_manage_editors: list.canManageEditors,
  });
};

export const postMeasure = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(CreateMeasureSchema, req);
  res.status(201).json(await createMeasure(callerOf(req), sourceId, body));
};
