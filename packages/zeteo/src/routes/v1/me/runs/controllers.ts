import { SAVED_QUERIES_READ } from "../../../../definitions/tereoDeclaration.js";
import { runsPage, savedQueryIdsOf } from "../../runs/controllers.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { groupIdsOf } from "../../../../grants/principals.js";
import { WITHHELD_QUERY } from "../../../../engine/record.js";
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
  // The JSON of a saved query is shown only while the caller could open it:
  // running a panel of someone else's dashboard does not hand it over.
  const canOpen = hasPermission(caller.permissions, SAVED_QUERIES_READ)
    ? new Set(ids)
    : await db.savedQueries.openableAmong(
        ids,
        caller.userId,
        await groupIdsOf(caller),
        caller.organizationId
      );
  const rows = page.rows.map((row) =>
    row.savedQueryId !== null && !canOpen.has(row.savedQueryId)
      ? { ...row, query: WITHHELD_QUERY }
      : row
  );
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(runsPage({ ...page, rows }, names));
};
