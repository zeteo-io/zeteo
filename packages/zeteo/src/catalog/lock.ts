import type { Prisma } from "../utils/db/prisma.js";

/**
 * Takes the transaction-scoped lock every write to a source's catalogue
 * (refresh, declaring and removing a relation) holds, so those writes apply
 * one after another.
 */
export const lockSourceCatalog = async (
  tx: Prisma.TransactionClient,
  sourceId: string
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zeteo:refresh:${sourceId}`}, 0))`;
};
