import type { QueryRun } from "../../../../prisma/generated/client/index.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { ListRunsQuerySchema, RunCursorSchema } from "./schemas.js";
import { validateQuery } from "../../../utils/validateReq.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import { runView } from "../../../views/run.js";

/** A page of runs as the response body, each run of a saved query given the name `names` has for it. */
export const runsPage = (
  page: { rows: QueryRun[]; hasMore: boolean },
  names: Map<string, string>
) => {
  const last = page.rows.at(-1);
  return {
    data: page.rows.map((row) => {
      const name =
        row.savedQueryId === null ? undefined : names.get(row.savedQueryId);
      return runView(
        row,
        name === undefined ? undefined : { id: row.savedQueryId!, name }
      );
    }),
    next_cursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  };
};

/** The ids of the saved queries the page's runs belong to. */
export const savedQueryIdsOf = (rows: QueryRun[]): string[] => [
  ...new Set(rows.flatMap((r) => (r.savedQueryId ? [r.savedQueryId] : []))),
];

export const listRuns = async (req: Request, res: Response) => {
  const query = validateQuery(ListRunsQuerySchema, req);
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, RunCursorSchema)[0];
  const page = await db.queryRuns.listPage({
    userId: query.user_id,
    sourceId: query.source_id,
    savedQueryId: query.saved_query_id,
    outcome: query.outcome,
    cursor,
    limit: query.limit,
  });
  const names = await db.savedQueries.namesOf(savedQueryIdsOf(page.rows));
  res.status(200).json(runsPage(page, names));
};
