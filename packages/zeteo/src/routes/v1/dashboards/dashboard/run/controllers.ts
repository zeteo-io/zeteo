import { findDashboardForViewer } from "../../../../../dashboards/service.js";
import { runDashboard as run } from "../../../../../dashboards/run.js";
import { serveLines } from "../../../../../utils/serveLines.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { DashboardParamsSchema } from "../schemas.js";
import { RunDashboardSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const runDashboard = async (req: Request, res: Response) => {
  const { dashboardId } = validateParams(DashboardParamsSchema, req);
  const body = validateBody(RunDashboardSchema, req);
  const caller = callerOf(req);
  const dashboard = await findDashboardForViewer(caller, dashboardId);
  await serveLines(req, res, (emit, signal) =>
    run(
      caller,
      dashboard,
      { panels: body.panels, timeRange: body.time_range },
      emit,
      signal
    )
  );
};
