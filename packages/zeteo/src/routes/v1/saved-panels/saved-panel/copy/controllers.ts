import { copySavedPanel as copy } from "../../../../../saved-panels/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SavedPanelParamsSchema } from "../schemas.js";
import { CopySavedPanelSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const copySavedPanel = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  const { name } = validateBody(CopySavedPanelSchema, req);
  res.status(201).json(await copy(callerOf(req), savedPanelId, name));
};
