import { callerOf } from "../../../../../middleware/auth.js";
import { SavedPanelParamsSchema } from "../schemas.js";
import { ReplaceSharesSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  listShares as list,
  replaceShares as replace,
} from "../../../../../saved-panels/service.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const listShares = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  res.status(200).json({ data: await list(callerOf(req), savedPanelId) });
};

export const replaceShares = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  const { principals } = validateBody(ReplaceSharesSchema, req);
  res.status(200).json(await replace(callerOf(req), savedPanelId, principals));
};
