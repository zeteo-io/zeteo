import { archiveSource as archive } from "../../../../../sources/service.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const archiveSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  await archive(sourceId, callerOf(req).userId);
  res.status(204).end();
};
