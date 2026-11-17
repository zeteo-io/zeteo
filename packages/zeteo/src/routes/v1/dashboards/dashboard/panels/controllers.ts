import { addPanel as add } from "../../../../../dashboards/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { DashboardParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import { PanelInputSchema } from "./schemas.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const addPanel = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  const body = validateBody(PanelInputSchema, req);
  res.status(201).json(await add(callerOf(req), dashboardId, body));
};
