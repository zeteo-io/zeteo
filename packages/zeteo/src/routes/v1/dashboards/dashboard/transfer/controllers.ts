import { transferDashboard as transfer } from "../../../../../dashboards/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { TransferDashboardSchema } from "./schemas.js";
import { DashboardParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const transferDashboard = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  const body = validateBody(TransferDashboardSchema, req);
  res.status(200).json(
    await transfer(callerOf(req), dashboardId, {
      userId: body.user_id,
      keepAccess: body.keep_access,
    })
  );
};
