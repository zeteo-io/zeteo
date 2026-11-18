import { SOURCES_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { acquireUploadSlot } from "../../../../uploads/uploadLimits.js";
import { callerOf, type Caller } from "../../../../middleware/auth.js";
import { FileParseError } from "../../../../uploads/parse/types.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { readSpreadsheet } from "../../../../google/sheets.js";
import { parseSheetLink } from "../../../../google/links.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { PostLinkBodySchema } from "./schemas.js";
import type { Request, Response } from "express";
import env from "../../../../env.js";
import {
  assertSheetUnclaimed,
  checkStagingRoom,
  stageSheets,
} from "../../../../uploads/staging.js";
import {
  FileUnreadableError,
  NotASheetsSourceError,
  NotFoundError,
  SourceArchivedError,
} from "../../../../utils/errors.js";

/**
 * The spreadsheet of the Sheets source `id`, for a caller who may change it
 * (its owner, or whoever holds `zeteo.sources.write`). A source that is
 * missing and one that is someone else's both answer 404.
 */
const spreadsheetOfSource = async (
  caller: Caller,
  id: string
): Promise<string> => {
  const row = await prisma.source.findUnique({
    where: { id },
    select: { type: true, ownerId: true, archivedAt: true, vendorFileId: true },
  });
  const may =
    row !== null &&
    (row.ownerId === caller.userId ||
      hasPermission(caller.permissions, SOURCES_WRITE));
  if (!row || !may) throw new NotFoundError("Source not found");
  if (row.type !== "google_sheets" || !row.vendorFileId) {
    throw new NotASheetsSourceError();
  }
  if (row.archivedAt) throw new SourceArchivedError();
  return row.vendorFileId;
};

/**
 * `POST /v1/uploads/links`: stages every tab of a Google spreadsheet, named
 * by `{ url }` (a link or an id) or by `{ source_id }` (the spreadsheet of a
 * Sheets source, to add tabs). A `url` already read by an unarchived source
 * is 409 `sheet_in_use`. Counts against `UPLOAD_MAX_STAGINGS` and the
 * caller's upload slots like a file.
 */
export const postLink = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const body = validateBody(PostLinkBodySchema, req);
  await checkStagingRoom(caller.userId);
  const release = await acquireUploadSlot(caller.userId);
  try {
    let spreadsheetId: string;
    if ("url" in body) {
      spreadsheetId = parseSheetLink(body.url);
      await assertSheetUnclaimed(spreadsheetId);
    } else {
      spreadsheetId = await spreadsheetOfSource(caller, body.source_id);
    }
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
      tables: result.staged.tables,
      spreadsheet: { id: spreadsheetId, title: result.title },
    });
  } finally {
    await release();
  }
};
