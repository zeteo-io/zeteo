import { prisma, type Prisma } from "../utils/db/prisma.js";
import { SheetInUseError } from "../utils/errors.js";

/**
 * Claims: one spreadsheet backs tables in at most one unarchived upload
 * source, the first to claim it. A claim is written (in `upload_claims`) in
 * the transaction that gives a source its first table of the spreadsheet,
 * released when the source's last table of it is removed or the source is
 * deleted, and moves with the source on a transfer (it names the source).
 * `sheet_in_use` never says whose a claim is.
 */

/** The vendor a Google Sheets claim is kept under. */
export const SHEETS_VENDOR = "google-sheets";

/**
 * Claims the spreadsheet for the source in `tx`: a claim the source already
 * holds is fine; another source's is `SheetInUseError`. A concurrent claim
 * by another source waits on the first to commit, then sees it.
 */
export const claimSpreadsheet = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
  spreadsheetId: string
): Promise<void> => {
  const inserted = await tx.$queryRaw<{ source_id: string }[]>`
    INSERT INTO "zeteo"."upload_claims" ("vendor", "file_id", "source_id")
    VALUES (${SHEETS_VENDOR}, ${spreadsheetId}, ${sourceId}::uuid)
    ON CONFLICT ("vendor", "file_id") DO NOTHING
    RETURNING "source_id"::text AS "source_id"`;
  if (inserted.length > 0) return;
  const held = await tx.uploadClaim.findUnique({
    where: {
      vendor_fileId: { vendor: SHEETS_VENDOR, fileId: spreadsheetId },
    },
    select: { sourceId: true },
  });
  if (held?.sourceId !== sourceId) throw new SheetInUseError();
};

/**
 * Deletes the source's claims of spreadsheets none of its tables comes from
 * any more. A table its owner removed does not count; one a sync marked
 * missing (its tab deleted in Sheets) does, as it comes back with its tab.
 */
export const releaseUnusedClaims = async (
  tx: Prisma.TransactionClient,
  sourceId: string
): Promise<void> => {
  await tx.$executeRaw`
    DELETE FROM "zeteo"."upload_claims" c
    WHERE c."source_id" = ${sourceId}::uuid
      AND c."vendor" = ${SHEETS_VENDOR}
      AND NOT EXISTS (
        SELECT 1 FROM "zeteo"."source_tables" t
        WHERE t."source_id" = c."source_id"
          AND t."origin"->>'kind' = 'google-sheets'
          AND t."origin"->>'spreadsheetId' = c."file_id"
          AND (t."origin"->>'removed') IS DISTINCT FROM 'true')`;
};

/** Deletes every claim of the source: it is being deleted. */
export const releaseAllClaims = async (
  tx: Prisma.TransactionClient,
  sourceId: string
): Promise<void> => {
  await tx.uploadClaim.deleteMany({ where: { sourceId } });
};

/**
 * A pre-check before reading or loading a spreadsheet: `SheetInUseError`
 * when a source other than `sourceId` claims it. The claim written in the
 * change's own transaction is the guard; this only answers early.
 */
export const assertSheetUnclaimed = async (
  spreadsheetId: string,
  sourceId?: string,
  db: Prisma.TransactionClient = prisma
): Promise<void> => {
  const held = await db.uploadClaim.findUnique({
    where: {
      vendor_fileId: { vendor: SHEETS_VENDOR, fileId: spreadsheetId },
    },
    select: { sourceId: true },
  });
  if (held && held.sourceId !== sourceId) throw new SheetInUseError();
};
