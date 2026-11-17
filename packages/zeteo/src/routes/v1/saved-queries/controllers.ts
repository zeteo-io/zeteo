import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { parseCursor } from "../../../utils/cursor.js";
import { callerOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  createSavedQuery as create,
  listSavedQueries as list,
} from "../../../saved-queries/service.js";
import {
  CreateSavedQuerySchema,
  ListSavedQueriesQuerySchema,
  SavedQueryCursorSchema,
} from "./schemas.js";

export const listSavedQueries = async (req: Request, res: Response) => {
  const query = validateQuery(ListSavedQueriesQuerySchema, req);
  const page = await list(callerOf(req), {
    scope: query.scope,
    q: query.q,
    sourceId: query.source_id,
    ownerId: query.owner_id,
    sharedWith:
      query.shared_with_type && query.shared_with_id
        ? { type: query.shared_with_type, id: query.shared_with_id }
        : undefined,
    cursor:
      query.cursor === undefined
        ? undefined
        : parseCursor(query.cursor, SavedQueryCursorSchema)[0],
    limit: query.limit,
  });
  res.status(200).json({ data: page.data, next_cursor: page.nextCursor });
};

export const createSavedQuery = async (req: Request, res: Response) => {
  const body = validateBody(CreateSavedQuerySchema, req);
  res.status(201).json(await create(callerOf(req), body));
};
