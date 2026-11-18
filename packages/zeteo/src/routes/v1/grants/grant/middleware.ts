import type { SourceLocator } from "../../../../middleware/fileSourceOwner.js";
import { idOrUndefined } from "../../../../middleware/fileSourceOwner.js";
import { prisma } from "../../../../utils/db/prisma.js";

/** The source of the grant's table. */
export const sourceOfGrant: SourceLocator = async (req) => {
  const grantId = idOrUndefined(req.params.grantId);
  if (grantId === undefined) return undefined;
  const grant = await prisma.grant.findUnique({
    where: { id: grantId },
    select: { table: { select: { sourceId: true } } },
  });
  return grant?.table.sourceId;
};
