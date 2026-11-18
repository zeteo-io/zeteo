import { ReuploadTableSchema, TableParamsSchema } from "./schemas.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  removeTable as remove,
  reuploadTable as reupload,
} from "../../../../../../file-sources/service.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const reuploadTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  const body = validateBody(ReuploadTableSchema, req);
  res.status(200).json(await reupload(callerOf(req), sourceId, tableId, body));
};

export const removeTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  await remove(callerOf(req), sourceId, tableId);
  res.status(204).end();
};
