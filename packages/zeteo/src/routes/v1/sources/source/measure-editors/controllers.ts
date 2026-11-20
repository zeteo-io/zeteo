import { callerOf } from "../../../../../middleware/auth.js";
import { ReplaceEditorsSchema } from "./schemas.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  listEditors,
  replaceEditors,
} from "../../../../../measures/service.js";

export const getEditors = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  res.status(200).json({ data: await listEditors(callerOf(req), sourceId) });
};

export const putEditors = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const { principals } = validateBody(ReplaceEditorsSchema, req);
  const caller = callerOf(req);
  await replaceEditors(caller, sourceId, principals);
  res.status(200).json({ data: await listEditors(caller, sourceId) });
};
