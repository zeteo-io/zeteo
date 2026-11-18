import { addTables as add } from "../../../../../file-sources/service.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { FileSourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import { AddTablesSchema } from "./schemas.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const addTables = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(FileSourceParamsSchema, req);
  const body = validateBody(AddTablesSchema, req);
  res.status(201).json(await add(callerOf(req), sourceId, body));
};
