import { refreshSource as refresh } from "../../../../../catalog/refresh.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const refreshSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  res.status(200).json(await refresh(sourceId, callerOf(req).userId));
};
