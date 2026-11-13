import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { ListRunsQuerySchema, RunCursorSchema } from "./schemas.js";
import { validateQuery } from "../../../utils/validateReq.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import { runView } from "../../../views/run.js";

export const listRuns = async (req: Request, res: Response) => {
  const query = validateQuery(ListRunsQuerySchema, req);
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, RunCursorSchema)[0];
  const page = await db.queryRuns.listPage({
    userId: query.user_id,
    sourceId: query.source_id,
    outcome: query.outcome,
    cursor,
    limit: query.limit,
  });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map(runView),
    next_cursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  });
};
