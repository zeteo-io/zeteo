import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { updateSource as update } from "../../../../sources/service.js";
import { SourceParamsSchema, UpdateSourceSchema } from "./schemas.js";
import { NotFoundError } from "../../../../utils/errors.js";
import { callerOf } from "../../../../middleware/auth.js";
import { sourceView } from "../../../../views/source.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const getSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const row = await db.sources.findById(sourceId);
  if (!row) throw new NotFoundError("Source not found");
  res.status(200).json(sourceView(row));
};

export const updateSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(UpdateSourceSchema, req);
  const row = await update(sourceId, body, callerOf(req).userId);
  res.status(200).json(sourceView(row));
};
