import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { principalStatuses } from "../../../grants/principalStatuses.js";
import { GRANTS_WRITE } from "../../../definitions/tereoDeclaration.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { createGrant as create } from "../../../grants/service.js";
import { GroupNotAllowedError } from "../../../utils/errors.js";
import { hasPermission } from "../../../utils/permissions.js";
import { groupsInReach } from "../../../sharing/shares.js";
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
  const caller = callerOf(req);
  // Past the route's check without `zeteo.grants.write`: the table's owner.
  const asOwner = !hasPermission(caller.permissions, GRANTS_WRITE);
  // Tereo is asked here, before the transaction.
  if (
    asOwner &&
    body.principal_type === "group" &&
    !(await groupsInReach(caller, [body.principal_id]))
  ) {
    throw new GroupNotAllowedError();
  }
  const row = await create(
    {
      principalType: body.principal_type,
      principalId: body.principal_id,
      tableId: body.table_id,
      columns: body.all_columns
        ? { allColumns: true }
        : { allColumns: false, columnIds: body.column_ids },
    },
    { actorId: caller.userId, ...(asOwner && { owner: caller }) }
  );
  const statuses = await principalStatuses([row]);
  res
    .status(201)
    .json(grantView(row, statuses.get(row.principalType, row.principalId)));
};
