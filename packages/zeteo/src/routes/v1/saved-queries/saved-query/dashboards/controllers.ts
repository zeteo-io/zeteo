import { validateParams } from "../../../../../utils/validateReq.js";
import { listUses } from "../../../../../saved-queries/service.js";
import { SavedQueryParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const listSavedQueryUses = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  res.status(200).json({ data: await listUses(savedQueryId) });
};
