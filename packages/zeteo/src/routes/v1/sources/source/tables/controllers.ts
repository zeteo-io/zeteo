import { encodeCursor, parseCursor } from "../../../../../utils/cursor.js";
import { ListTablesQuerySchema, TableCursorSchema } from "./schemas.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { tableView } from "../../../../../views/catalog.js";
import { db } from "../../../../../utils/db/index.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";

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
