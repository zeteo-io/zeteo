import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { updateSource as update } from "../../../../sources/service.js";
import { SourceParamsSchema, UpdateSourceSchema } from "./schemas.js";
import { refreshAfterChange } from "../../../../catalog/refresh.js";
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
  const actorId = callerOf(req).userId;
  const updated = await update(sourceId, body, actorId);
  // New settings or schemas describe another target: the catalogue follows now,
  // not at the next daily refresh. The change stands whether or not this works.
  if (body.settings === undefined && body.schemas === undefined) {
    res.status(200).json(sourceView(updated));
    return;
  }
  await refreshAfterChange(updated.id, actorId);
  const row = (await db.sources.findById(updated.id)) ?? updated;
  res.status(200).json(sourceView(row));
};
