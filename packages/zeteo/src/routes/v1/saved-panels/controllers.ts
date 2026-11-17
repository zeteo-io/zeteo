import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { parseCursor } from "../../../utils/cursor.js";
import { callerOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  createSavedPanel as create,
  listSavedPanels as list,
} from "../../../saved-panels/service.js";
import {
  CreateSavedPanelSchema,
  ListSavedPanelsQuerySchema,
  SavedPanelCursorSchema,
} from "./schemas.js";

export const listSavedPanels = async (req: Request, res: Response) => {
  const query = validateQuery(ListSavedPanelsQuerySchema, req);
  const page = await list(callerOf(req), {
    scope: query.scope,
    q: query.q,
    ownerId: query.owner_id,
    cursor:
      query.cursor === undefined
        ? undefined
        : parseCursor(query.cursor, SavedPanelCursorSchema)[0],
    limit: query.limit,
  });
  res.status(200).json({ data: page.data, next_cursor: page.nextCursor });
};

export const createSavedPanel = async (req: Request, res: Response) => {
  const body = validateBody(CreateSavedPanelSchema, req);
  res.status(201).json(
    await create(callerOf(req), {
      name: body.name,
      description: body.description,
      savedQueryId: body.saved_query_id,
      chart: body.chart,
      timeColumn: body.time_column,
    })
  );
};
