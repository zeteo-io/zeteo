import { saveMergedTable } from "../../../../../uploads/merged.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import { MergedTableSchema } from "./schemas.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

/** An upload source only: creates a merged table of its tables. */
export const createMergedTable = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(MergedTableSchema, req);
  res.status(201).json(await saveMergedTable(callerOf(req), sourceId, body));
};
