import { groupMemberIds } from "../principals/directory.js";
import { mapConcurrently } from "../utils/concurrency.js";
import { NotFoundError } from "../utils/errors.js";
import { prisma } from "../utils/db/prisma.js";

/** How many groups' members are read from tereo at once. */
const GROUPS_IN_FLIGHT = 4;

export interface MissingUser {
  user_id: string;
  via_grant_ids: string[];
}

/**
 * The users a grant whose rule uses the key reaches (its user, or the members
 * of its group) who hold no value under the key, by user id, each with the
 * grants that reach them. Asks tereo for group members, so it never runs
 * inside a transaction. An unknown key is a 404.
 */
export const missingValues = async (keyId: string): Promise<MissingUser[]> => {
  const key = await prisma.identityKey.findUnique({
    where: { id: keyId },
    select: { id: true },
  });
  if (!key) throw new NotFoundError("Identity key not found");

  const grants = await prisma.grant.findMany({
    // The grants loadAccess counts: on a live source, with at least one column.
    where: {
      identityKeyIds: { has: keyId },
      table: { source: { archivedAt: null } },
      OR: [{ allColumns: true }, { columns: { some: {} } }],
    },
    select: { id: true, principalType: true, principalId: true },
    orderBy: { id: "asc" },
  });

  const via = new Map<string, string[]>();
  const reach = (userId: string, grantId: string) => {
    const ids = via.get(userId) ?? [];
    if (!ids.includes(grantId)) ids.push(grantId);
    via.set(userId, ids);
  };
  for (const g of grants) {
    if (g.principalType === "user") reach(g.principalId, g.id);
  }
  const groupGrants = new Map<string, string[]>();
  for (const g of grants) {
    if (g.principalType !== "group") continue;
    groupGrants.set(g.principalId, [
      ...(groupGrants.get(g.principalId) ?? []),
      g.id,
    ]);
  }
  await mapConcurrently(
    [...groupGrants.keys()],
    GROUPS_IN_FLIGHT,
    async (groupId) => {
      for (const userId of await groupMemberIds(groupId)) {
        for (const grantId of groupGrants.get(groupId)!) reach(userId, grantId);
      }
    }
  );
  if (via.size === 0) return [];

  const holding = await prisma.identityValue.findMany({
    where: { keyId, userId: { in: [...via.keys()] } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const held = new Set(holding.map((v) => v.userId));
  return [...via]
    .filter(([userId]) => !held.has(userId))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([userId, grantIds]) => ({
      user_id: userId,
      via_grant_ids: [...grantIds].sort(),
    }));
};
