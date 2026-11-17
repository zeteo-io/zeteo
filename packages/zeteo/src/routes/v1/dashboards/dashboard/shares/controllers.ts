import { callerOf } from "../../../../../middleware/auth.js";
import { DashboardParamsSchema } from "../schemas.js";
import { ReplaceSharesSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  listShares as list,
  replaceShares as replace,
} from "../../../../../dashboards/service.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const listShares = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  res.status(200).json({ data: await list(callerOf(req), dashboardId) });
};

export const replaceShares = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  const { principals } = validateBody(ReplaceSharesSchema, req);
  res.status(200).json(await replace(callerOf(req), dashboardId, principals));
};
