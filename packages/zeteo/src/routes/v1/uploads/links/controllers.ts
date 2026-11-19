import { checkStagingRoom, stageSheets } from "../../../../uploads/staging.js";
import { SOURCES_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { acquireUploadSlot } from "../../../../uploads/uploadLimits.js";
import { callerOf, type Caller } from "../../../../middleware/auth.js";
import { markTabsAlreadyAdded } from "../../../../uploads/service.js";
import { assertSheetUnclaimed } from "../../../../uploads/claims.js";
import { FileParseError } from "../../../../uploads/parse/types.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { readSpreadsheet } from "../../../../google/sheets.js";
import { isUploadSource } from "../../../../sources/types.js";
import { parseSheetLink } from "../../../../google/links.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { PostLinkBodySchema } from "./schemas.js";
import type { Request, Response } from "express";
import env from "../../../../env.js";
import {
  FileUnreadableError,
  NotAnUploadSourceError,
  NotFoundError,
  SourceArchivedError,
} from "../../../../utils/errors.js";

/**
 * Checks that the caller may add tables to the source `id` (its owner, or
 * whoever holds `zeteo.sources.write`): a source that is missing and one that
 * is someone else's both answer 404; a database source is 409
 * `not_an_upload_source`, an archived one `source_archived`.
 */
const checkTarget = async (caller: Caller, id: string): Promise<void> => {
  const row = await prisma.source.findUnique({
    where: { id },
    select: { type: true, ownerId: true, archivedAt: true },
  });
  const may =
    row !== null &&
    (row.ownerId === caller.userId ||
      hasPermission(caller.permissions, SOURCES_WRITE));
  if (!row || !may) throw new NotFoundError("Source not found");
  if (!isUploadSource(row)) throw new NotAnUploadSourceError();
  if (row.archivedAt) throw new SourceArchivedError();
};

/**
 * `POST /v1/uploads/links`: stages every tab of a Google spreadsheet named
 * by `url` (a link or an id), for a new source or, with `source_id`, to add
 * tables to that upload source. A spreadsheet another source claims is 409
 * `sheet_in_use` (the source's own claim is fine). Counts against
 * `UPLOAD_MAX_STAGINGS` and the caller's upload slots like a file.
 */
export const postLink = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const body = validateBody(PostLinkBodySchema, req);
  await checkStagingRoom(caller.userId);
  const release = await acquireUploadSlot(caller.userId);
  try {
    const sourceId = "source_id" in body ? body.source_id : undefined;
    if (sourceId !== undefined) await checkTarget(caller, sourceId);
    const spreadsheetId = parseSheetLink(body.url);
    await assertSheetUnclaimed(spreadsheetId, sourceId);
    const result = await (async () => {
      try {
        const spreadsheet = await readSpreadsheet(spreadsheetId, {
          maxRows: env.UPLOAD_MAX_ROWS,
          maxColumns: env.UPLOAD_MAX_COLUMNS,
        });
        return {
          staged: await stageSheets({
            ownerId: caller.userId,
            spreadsheet: { id: spreadsheetId, ...spreadsheet },
          }),
          title: spreadsheet.title,
        };
      } catch (err) {
        throw err instanceof FileParseError
          ? new FileUnreadableError(err.code, err.message, err.row)
          : err;
      }
    })();
    res.status(201).json({
      staging_id: result.staged.stagingId,
      expires_at: result.staged.expiresAt.toISOString(),
      tables:
        sourceId === undefined
          ? result.staged.tables
          : await markTabsAlreadyAdded(
              sourceId,
              spreadsheetId,
              result.staged.tables
            ),
      spreadsheet: { id: spreadsheetId, title: result.title },
    });
  } finally {
    await release();
  }
};
