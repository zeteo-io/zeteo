import type { SourceLocator } from "../../../middleware/fileSourceOwner.js";
import { idOrUndefined } from "../../../middleware/fileSourceOwner.js";
import { prisma } from "../../../utils/db/prisma.js";

/** A list's `source_id`: an owner may list the grants of their own file source. */
export const sourceOfListQuery: SourceLocator = async (req) =>
  idOrUndefined(req.query.source_id);

/** The source of a new grant's `table_id`. */
export const sourceOfBodyTable: SourceLocator = async (req) => {
  const tableId = idOrUndefined(
    (req.body as { table_id?: unknown } | undefined)?.table_id
  );
  if (tableId === undefined) return undefined;
  const table = await prisma.sourceTable.findUnique({
    where: { id: tableId },
    select: { sourceId: true },
  });
  return table?.sourceId;
};
