import { copySavedQuery as copy } from "../../../../../saved-queries/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SavedQueryParamsSchema } from "../schemas.js";
import { CopySavedQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const copySavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  const { name } = validateBody(CopySavedQuerySchema, req);
  res.status(201).json(await copy(callerOf(req), savedQueryId, name));
};
