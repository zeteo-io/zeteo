import { tableDetailView } from "../../../../../../views/catalog.js";
import { describeTable } from "../../../../../../catalog/service.js";
import { PatchTableSchema, TableParamsSchema } from "./schemas.js";
import { NotFoundError } from "../../../../../../utils/errors.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { db } from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const getTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  const table = await db.catalog.findTable(sourceId, tableId);
  if (!table) throw new NotFoundError("Table not found");
  const [columns, relations] = await Promise.all([
    db.catalog.listColumns(tableId),
    db.catalog.listRelationsFrom(tableId),
  ]);
  res.status(200).json(tableDetailView(table, columns, relations));
};

export const patchTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  const body = validateBody(PatchTableSchema, req);
  const { table, columns, relations } = await describeTable(
    sourceId,
    tableId,
    body,
    callerOf(req).userId
  );
  res.status(200).json(tableDetailView(table, columns, relations));
};
