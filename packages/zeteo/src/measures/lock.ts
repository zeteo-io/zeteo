import type { Prisma } from "../utils/db/prisma.js";

/**
 * Takes the transaction-scoped lock every change to a source's measures or
 * their editors holds, so the checks of one change see the others' results.
 */
export const lockSourceMeasures = async (
  tx: Prisma.TransactionClient,
  sourceId: string
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zeteo:measures:${sourceId}`}, 0))`;
};
