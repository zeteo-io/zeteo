import { changeColumn } from "../../../../../../../../file-sources/service.js";
import { callerOf } from "../../../../../../../../middleware/auth.js";
import { ColumnParamsSchema, UpdateColumnSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../../../utils/validateReq.js";

export const updateColumn = async (req: Request, res: Response) => {
  const { sourceId, tableId, columnId } = validateParams(
    ColumnParamsSchema,
    req
  );
  const body = validateBody(UpdateColumnSchema, req);
  res
    .status(200)
    .json(await changeColumn(callerOf(req), sourceId, tableId, columnId, body));
};
