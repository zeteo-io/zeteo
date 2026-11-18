import { discardOwnStaging } from "../../../../uploads/staging.js";
import { validateParams } from "../../../../utils/validateReq.js";
import { callerOf } from "../../../../middleware/auth.js";
import { UploadParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";

/** Discards the caller's own staging: its tables and its place under the cap. */
export const deleteUpload = async (req: Request, res: Response) => {
  const { uploadId } = validateParams(UploadParamsSchema, req);
  await discardOwnStaging(uploadId, callerOf(req).userId);
  res.status(204).end();
};
