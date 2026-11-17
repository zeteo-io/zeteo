import { copyDashboard as copy } from "../../../../../dashboards/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { DashboardParamsSchema } from "../schemas.js";
import { CopyDashboardSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const copyDashboard = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  const { name } = validateBody(CopyDashboardSchema, req);
  res.status(201).json(await copy(callerOf(req), dashboardId, name));
};
