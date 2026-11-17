import { saveFromPanel as save } from "../../../../../../../saved-panels/service.js";
import { callerOf } from "../../../../../../../middleware/auth.js";
import { SaveAsSavedPanelSchema } from "./schemas.js";
import { PanelParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../../utils/validateReq.js";

export const saveAsSavedPanel = async (req: Request, res: Response) => {
  const { dashboardId, panelId } = validateParams(PanelParamsSchema, req);
  const body = validateBody(SaveAsSavedPanelSchema, req);
  res.status(201).json(await save(callerOf(req), dashboardId, panelId, body));
};
