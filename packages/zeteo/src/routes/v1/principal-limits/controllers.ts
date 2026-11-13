import { createPrincipalLimit as create } from "../../../limits/service.js";
import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { principalStatuses } from "../../../grants/principalStatuses.js";
import { principalLimitView } from "../../../views/principalLimit.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { callerOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import {
  CreatePrincipalLimitSchema,
  ListPrincipalLimitsQuerySchema,
  PrincipalLimitCursorSchema,
} from "./schemas.js";

export const listPrincipalLimits = async (req: Request, res: Response) => {
  const query = validateQuery(ListPrincipalLimitsQuerySchema, req);
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, PrincipalLimitCursorSchema)[0];
  const page = await db.principalLimits.listPage({
    principalType: query.principal_type,
    principalId: query.principal_id,
    cursor,
    limit: query.limit,
  });
  const statuses = await principalStatuses(page.rows);
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map((row) =>
      principalLimitView(row, statuses.get(row.principalType, row.principalId))
    ),
    next_cursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  });
};

export const createPrincipalLimit = async (req: Request, res: Response) => {
  const body = validateBody(CreatePrincipalLimitSchema, req);
  const row = await create(
    {
      principalType: body.principal_type,
      principalId: body.principal_id,
      queryConcurrency: body.query_concurrency,
      exportConcurrency: body.export_concurrency,
    },
    callerOf(req).userId
  );
  const statuses = await principalStatuses([row]);
  res
    .status(201)
    .json(
      principalLimitView(row, statuses.get(row.principalType, row.principalId))
    );
};
