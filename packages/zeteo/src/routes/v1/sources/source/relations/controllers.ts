import { declareRelation as declare } from "../../../../../catalog/service.js";
import { encodeCursor, parseCursor } from "../../../../../utils/cursor.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { relationView } from "../../../../../views/catalog.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { db } from "../../../../../utils/db/index.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  DeclareRelationSchema,
  ListRelationsQuerySchema,
  RelationCursorSchema,
} from "./schemas.js";

export const listRelations = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const query = validateQuery(ListRelationsQuerySchema, req);
  const afterId =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, RelationCursorSchema)[0];
  if (!(await db.sources.findById(sourceId))) {
    throw new NotFoundError("Source not found");
  }
  const page = await db.catalog.listRelationsPage({
    sourceId,
    limit: query.limit,
    afterId,
  });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map(relationView),
    next_cursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  });
};

export const declareRelation = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(DeclareRelationSchema, req);
  const relation = await declare(
    sourceId,
    {
      name: body.name,
      fromTableId: body.from_table_id,
      fromColumns: body.from_columns,
      toTableId: body.to_table_id,
      toColumns: body.to_columns,
      toMany: body.to_many,
    },
    callerOf(req).userId
  );
  res.status(201).json(relationView(relation));
};
