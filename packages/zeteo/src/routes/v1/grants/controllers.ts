import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { principalStatuses } from "../../../grants/principalStatuses.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { createGrant as create } from "../../../grants/service.js";
import { callerOf } from "../../../middleware/auth.js";
import { grantView } from "../../../views/grant.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import {
  CreateGrantSchema,
  GrantCursorSchema,
  ListGrantsQuerySchema,
} from "./schemas.js";

export const listGrants = async (req: Request, res: Response) => {
  const query = validateQuery(ListGrantsQuerySchema, req);
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, GrantCursorSchema)[0];
  const page = await db.grants.listPage({
    principalType: query.principal_type,
    principalId: query.principal_id,
    tableId: query.table_id,
    sourceId: query.source_id,
    cursor,
    limit: query.limit,
  });
  const statuses = await principalStatuses(page.rows);
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map((row) =>
      grantView(row, statuses.get(row.principalType, row.principalId))
    ),
    next_cursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  });
};

export const createGrant = async (req: Request, res: Response) => {
  const body = validateBody(CreateGrantSchema, req);
  const row = await create(
    {
      principalType: body.principal_type,
      principalId: body.principal_id,
      tableId: body.table_id,
      columns: body.all_columns
        ? { allColumns: true }
        : { allColumns: false, columnIds: body.column_ids },
    },
    callerOf(req).userId
  );
  const statuses = await principalStatuses([row]);
  res
    .status(201)
    .json(grantView(row, statuses.get(row.principalType, row.principalId)));
};
