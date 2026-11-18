import { encodeCursor, parseCursor } from "../../../../../utils/cursor.js";
import { addTables as add } from "../../../../../file-sources/service.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { tableView } from "../../../../../views/catalog.js";
import { db } from "../../../../../utils/db/index.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  AddTablesSchema,
  ListTablesQuerySchema,
  TableCursorSchema,
} from "./schemas.js";

export const listTables = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const query = validateQuery(ListTablesQuerySchema, req);
  let after: { schemaName: string; name: string } | undefined;
  if (query.cursor !== undefined) {
    const [schemaName, name] = parseCursor(query.cursor, TableCursorSchema);
    after = { schemaName, name };
  }
  if (!(await db.sources.findById(sourceId))) {
    throw new NotFoundError("Source not found");
  }
  const page = await db.catalog.listTablesPage({
    sourceId,
    includeMissing: query.include_missing,
    limit: query.limit,
    after,
  });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map(tableView),
    next_cursor:
      page.hasMore && last ? encodeCursor([last.schemaName, last.name]) : null,
  });
};

/** An upload source only: adds the staging's tables. */
export const addTables = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(AddTablesSchema, req);
  res.status(201).json(await add(callerOf(req), sourceId, body));
};
