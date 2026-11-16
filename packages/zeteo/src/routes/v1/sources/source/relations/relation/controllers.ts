import { RelationParamsSchema, RenameRelationSchema } from "../schemas.js";
import { relationView } from "../../../../../../views/catalog.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  removeRelation,
  renameRelation,
} from "../../../../../../catalog/service.js";

export const patchRelation = async (req: Request, res: Response) => {
  const { sourceId, relationId } = validateParams(RelationParamsSchema, req);
  const { name } = validateBody(RenameRelationSchema, req);
  const relation = await renameRelation(
    sourceId,
    relationId,
    name,
    callerOf(req).userId
  );
  res.status(200).json(relationView(relation));
};

export const deleteRelation = async (req: Request, res: Response) => {
  const { sourceId, relationId } = validateParams(RelationParamsSchema, req);
  await removeRelation(sourceId, relationId, callerOf(req).userId);
  res.status(204).end();
};
