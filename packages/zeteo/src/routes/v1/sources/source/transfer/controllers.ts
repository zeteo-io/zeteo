import { transferFileSource } from "../../../../../file-sources/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { TransferSourceSchema } from "./schemas.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

/** An upload source only: hands it to another user. */
export const transferSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(TransferSourceSchema, req);
  res.status(200).json(
    await transferFileSource(callerOf(req), sourceId, {
      userId: body.user_id,
      keepAccess: body.keep_access,
    })
  );
};
