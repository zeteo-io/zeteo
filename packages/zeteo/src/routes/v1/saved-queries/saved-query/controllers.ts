import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { SavedQueryParamsSchema, UpdateSavedQuerySchema } from "./schemas.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  deleteSavedQuery as remove,
  getSavedQuery as get,
  updateSavedQuery as update,
} from "../../../../saved-queries/service.js";

export const getSavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  res.status(200).json(await get(callerOf(req), savedQueryId));
};

export const updateSavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  const { available_for_dashboards: availableForDashboards, ...rest } =
    validateBody(UpdateSavedQuerySchema, req);
  res.status(200).json(
    await update(callerOf(req), savedQueryId, {
      ...rest,
      availableForDashboards,
    })
  );
};

export const deleteSavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  await remove(callerOf(req), savedQueryId);
  res.status(204).end();
};
