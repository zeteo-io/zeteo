import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { parseCursor } from "../../../utils/cursor.js";
import { callerOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  createDashboard as create,
  listDashboards as list,
} from "../../../dashboards/service.js";
import {
  CreateDashboardSchema,
  DashboardCursorSchema,
  ListDashboardsQuerySchema,
} from "./schemas.js";

export const listDashboards = async (req: Request, res: Response) => {
  const query = validateQuery(ListDashboardsQuerySchema, req);
  const page = await list(callerOf(req), {
    scope: query.scope,
    q: query.q,
    ownerId: query.owner_id,
    cursor:
      query.cursor === undefined
        ? undefined
        : parseCursor(query.cursor, DashboardCursorSchema)[0],
    limit: query.limit,
  });
  res.status(200).json({ data: page.data, next_cursor: page.nextCursor });
};

export const createDashboard = async (req: Request, res: Response) => {
  const body = validateBody(CreateDashboardSchema, req);
  res.status(201).json(await create(callerOf(req), body));
};
