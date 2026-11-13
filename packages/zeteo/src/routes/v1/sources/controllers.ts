import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { createSource as create } from "../../../sources/service.js";
import { refreshAfterChange } from "../../../catalog/refresh.js";
import { callerOf } from "../../../middleware/auth.js";
import { sourceView } from "../../../views/source.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import {
  CreateSourceSchema,
  ListSourcesQuerySchema,
  SourceCursorSchema,
} from "./schemas.js";

export const listSources = async (req: Request, res: Response) => {
  const query = validateQuery(ListSourcesQuerySchema, req);
  let after: { createdAt: Date; id: string } | undefined;
  if (query.cursor !== undefined) {
    const [createdAt, id] = parseCursor(query.cursor, SourceCursorSchema);
    after = { createdAt: new Date(createdAt), id };
  }
  const page = await db.sources.listPage({
    includeArchived: query.include_archived,
    limit: query.limit,
    after,
  });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map(sourceView),
    next_cursor:
      page.hasMore && last
        ? encodeCursor([last.createdAt.toISOString(), last.id])
        : null,
  });
};

export const createSource = async (req: Request, res: Response) => {
  const body = validateBody(CreateSourceSchema, req);
  const actorId = callerOf(req).userId;
  const created = await create(body, actorId);
  await refreshAfterChange(created.id, actorId);
  const row = (await db.sources.findById(created.id)) ?? created;
  res.status(201).json(sourceView(row));
};
