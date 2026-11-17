import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { SavedPanelParamsSchema, UpdateSavedPanelSchema } from "./schemas.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  deleteSavedPanel as remove,
  getSavedPanel as get,
  updateSavedPanel as update,
} from "../../../../saved-panels/service.js";

export const getSavedPanel = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  res.status(200).json(await get(callerOf(req), savedPanelId));
};

export const updateSavedPanel = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  const body = validateBody(UpdateSavedPanelSchema, req);
  res.status(200).json(await update(callerOf(req), savedPanelId, body));
};

export const deleteSavedPanel = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  await remove(callerOf(req), savedPanelId);
  res.status(204).end();
};
