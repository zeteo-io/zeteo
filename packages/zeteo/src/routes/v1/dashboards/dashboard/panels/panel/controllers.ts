import { PanelParamsSchema, UpdatePanelSchema } from "./schemas.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  removePanel as remove,
  updatePanel as update,
} from "../../../../../../dashboards/service.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const updatePanel = async (req: Request, res: Response) => {
  const { dashboardId, panelId } = validateParams(PanelParamsSchema, req);
  const body = validateBody(UpdatePanelSchema, req);
  res.status(200).json(await update(callerOf(req), dashboardId, panelId, body));
};

export const removePanel = async (req: Request, res: Response) => {
  const { dashboardId, panelId } = validateParams(PanelParamsSchema, req);
  await remove(callerOf(req), dashboardId, panelId);
  res.status(204).end();
};
