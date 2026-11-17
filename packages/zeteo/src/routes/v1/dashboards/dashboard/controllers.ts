import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { DashboardParamsSchema, UpdateDashboardSchema } from "./schemas.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  deleteDashboard as remove,
  getDashboard as get,
  updateDashboard as update,
} from "../../../../dashboards/service.js";

export const getDashboard = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  res.status(200).json(await get(callerOf(req), dashboardId));
};

export const updateDashboard = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  const body = validateBody(UpdateDashboardSchema, req);
  res.status(200).json(await update(callerOf(req), dashboardId, body));
};

export const deleteDashboard = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  await remove(callerOf(req), dashboardId);
  res.status(204).end();
};
