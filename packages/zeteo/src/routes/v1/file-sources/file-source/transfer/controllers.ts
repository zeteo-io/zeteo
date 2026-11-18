import { transferFileSource as transfer } from "../../../../../file-sources/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { TransferFileSourceSchema } from "./schemas.js";
import { FileSourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const transferFileSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(FileSourceParamsSchema, req);
  const body = validateBody(TransferFileSourceSchema, req);
  res.status(200).json(
    await transfer(callerOf(req), sourceId, {
      userId: body.user_id,
      keepAccess: body.keep_access,
    })
  );
};
