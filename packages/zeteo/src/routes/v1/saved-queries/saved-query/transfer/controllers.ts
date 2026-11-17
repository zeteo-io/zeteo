import { transferSavedQuery as transfer } from "../../../../../saved-queries/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { TransferSavedQuerySchema } from "./schemas.js";
import { SavedQueryParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const transferSavedQuery = async (req: Request, res: Response) => {
  const { savedQueryId } = validateParams(SavedQueryParamsSchema, req);
  const body = validateBody(TransferSavedQuerySchema, req);
  res.status(200).json(
    await transfer(callerOf(req), savedQueryId, {
      userId: body.user_id,
      keepAccess: body.keep_access,
    })
  );
};
