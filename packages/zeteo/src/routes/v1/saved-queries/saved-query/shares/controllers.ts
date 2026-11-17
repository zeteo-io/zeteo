import { callerOf } from "../../../../../middleware/auth.js";
import { SavedQueryParamsSchema } from "../schemas.js";
import { ReplaceSharesSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  listShares as list,
  replaceShares as replace,
} from "../../../../../saved-queries/service.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const listShares = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  res.status(200).json({ data: await list(callerOf(req), savedQueryId) });
};

export const replaceShares = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  const { principals } = validateBody(ReplaceSharesSchema, req);
  res.status(200).json(await replace(callerOf(req), savedQueryId, principals));
};
