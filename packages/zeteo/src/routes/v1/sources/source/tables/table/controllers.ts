import { tableDetailView } from "../../../../../../views/catalog.js";
import { describeTable } from "../../../../../../catalog/service.js";
import { NotFoundError } from "../../../../../../utils/errors.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { db } from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  removeTable as remove,
  reuploadTable as reupload,
} from "../../../../../../uploads/service.js";
import {
  PatchTableSchema,
  ReuploadTableSchema,
  TableParamsSchema,
} from "./schemas.js";

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

/** An upload source only: replaces the table's data from a staging. */
export const reuploadTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  const body = validateBody(ReuploadTableSchema, req);
  res.status(200).json(await reupload(callerOf(req), sourceId, tableId, body));
};

/** An upload source only: drops the table and marks it missing. */
export const removeTable = async (req: Request, res: Response) => {
  const { sourceId, tableId } = validateParams(TableParamsSchema, req);
  await remove(callerOf(req), sourceId, tableId);
  res.status(204).end();
};
