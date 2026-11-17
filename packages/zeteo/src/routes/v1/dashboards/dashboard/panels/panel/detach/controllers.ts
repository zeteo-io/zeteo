import { detachPanel as detach } from "../../../../../../../dashboards/service.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { callerOf } from "../../../../../../../middleware/auth.js";
import { PanelParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const detachPanel = async (req: Request, res: Response) => {
  const { dashboardId, panelId } = validateParams(PanelParamsSchema, req);
  res.status(200).json(await detach(callerOf(req), dashboardId, panelId));
};
