import { validateParams } from "../../../../../../utils/validateReq.js";
import { removeRelation } from "../../../../../../catalog/service.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { RelationParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const deleteRelation = async (req: Request, res: Response) => {
  const { sourceId, relationId } = validateParams(RelationParamsSchema, req);
  await removeRelation(sourceId, relationId, callerOf(req).userId);
  res.status(204).end();
};
