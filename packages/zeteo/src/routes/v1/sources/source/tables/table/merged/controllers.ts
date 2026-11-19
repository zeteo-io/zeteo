import { saveMergedTable } from "../../../../../../../uploads/merged.js";
import { callerOf } from "../../../../../../../middleware/auth.js";
import { TableParamsSchema } from "../schemas.js";
import { MergedTableSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../../utils/validateReq.js";

/** A merged table only: replaces its definition. */
export const putMergedTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  const body = validateBody(MergedTableSchema, req);
  res
    .status(200)
    .json(await saveMergedTable(callerOf(req), sourceId, body, tableId));
};
