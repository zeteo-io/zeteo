import { runsPage, savedQueryIdsOf } from "../../runs/controllers.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { groupIdsOf } from "../../../../grants/principals.js";
import { parseCursor } from "../../../../utils/cursor.js";
import { callerOf } from "../../../../middleware/auth.js";
import { RunCursorSchema } from "../../runs/schemas.js";
import { ListMyRunsQuerySchema } from "./schemas.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const listMyRuns = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const query = validateQuery(ListMyRunsQuerySchema, req);
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, RunCursorSchema)[0];
  const page = await db.queryRuns.listPage({
    userId: caller.userId,
    // Only ever the caller's own runs, so naming any id reveals nothing.
    savedQueryId: query.saved_query_id,
    outcome: query.outcome,
    cursor,
    limit: query.limit,
  });
  // A saved query is named only while the caller owns it or it is shared with them.
  const ids = savedQueryIdsOf(page.rows);
  const names =
    ids.length === 0
      ? new Map<string, string>()
      : await db.savedQueries.namesVisibleTo(
          ids,
          caller.userId,
          await groupIdsOf(caller)
        );
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(runsPage(page, names));
};
