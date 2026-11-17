import { transferSavedPanel as transfer } from "../../../../../saved-panels/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { TransferSavedPanelSchema } from "./schemas.js";
import { SavedPanelParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const transferSavedPanel = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  const body = validateBody(TransferSavedPanelSchema, req);
  res.status(200).json(
    await transfer(callerOf(req), savedPanelId, {
      userId: body.user_id,
      keepAccess: body.keep_access,
    })
  );
};
