import { prisma, type Prisma } from "./prisma.js";
import type { Principal } from "./grants.js";
import type {
  PrincipalType,
  SavedPanel,
  SavedPanelShare,
} from "../../../prisma/generated/client/index.js";

/** The client or the open transaction a repository function runs on. */
type Db = Prisma.TransactionClient | typeof prisma;

export interface SavedPanelInput {
  ownerId: string;
  name: string;
  description: string;
  savedQueryId: string | null;
  chart: Prisma.InputJsonValue;
  timeColumn: string | null;
}

export type SavedPanelChanges = Partial<Omit<SavedPanelInput, "ownerId">>;

const nameFilter = (q: string | undefined) =>
  q ? { name: { contains: q, mode: "insensitive" as const } } : {};

export const findById = (
  id: string,
  tx: Db = prisma
): Promise<SavedPanel | null> => tx.savedPanel.findUnique({ where: { id } });

/**
 * One page, newest first (ids are time-ordered), starting after the `cursor` id.
 * `"mine"` is what `userId` owns; `"shared"` is what is shared with the user or
 * with any of their groups, never what they own.
 */
export const listVisibleTo = async (
  options: {
    userId: string;
    groupIds: string[];
    scope: "mine" | "shared";
    q?: string;
    cursor?: string;
    limit: number;
  },
  tx: Db = prisma
): Promise<{ rows: SavedPanel[]; hasMore: boolean }> => {
  const { userId, groupIds, scope, q, cursor, limit } = options;
  const reaching: Prisma.SavedPanelShareWhereInput = {
    OR: [
      { principalType: "user", principalId: userId },
      ...(groupIds.length > 0
        ? [{ principalType: "group" as const, principalId: { in: groupIds } }]
        : []),
    ],
  };
  const rows = await tx.savedPanel.findMany({
    where: {
      ...(scope === "mine"
        ? { ownerId: userId }
        : { ownerId: { not: userId }, shares: { some: reaching } }),
      ...nameFilter(q),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

/** Every one, optionally narrowed to an owner or a name, newest first, after the `cursor` id. */
export const listAll = async (
  options: { ownerId?: string; q?: string; cursor?: string; limit: number },
  tx: Db = prisma
): Promise<{ rows: SavedPanel[]; hasMore: boolean }> => {
  const { ownerId, q, cursor, limit } = options;
  const rows = await tx.savedPanel.findMany({
    where: {
      ...(ownerId && { ownerId }),
      ...nameFilter(q),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

export const create = (
  data: SavedPanelInput,
  tx: Db = prisma
): Promise<SavedPanel> => tx.savedPanel.create({ data });

export const update = (
  id: string,
  data: SavedPanelChanges,
  tx: Db = prisma
): Promise<SavedPanel> => tx.savedPanel.update({ where: { id }, data });

/** Deletes the saved panel; its shares go with it, and a dashboard panel linked to it stays, with no link. */
export const remove = (id: string, tx: Db = prisma): Promise<SavedPanel> =>
  tx.savedPanel.delete({ where: { id } });

/** How many saved panels are built on the saved query. */
export const countUsingSavedQuery = async (
  savedQueryId: string,
  tx: Db = prisma
): Promise<number> => tx.savedPanel.count({ where: { savedQueryId } });

const key = (p: Principal) => `${p.type}:${p.id}`;

/** Makes the shares exactly `principals`; resolves who was added and who removed. Shares already there keep their `createdBy` and `createdAt`. */
export const replaceShares = async (
  tx: Db,
  savedPanelId: string,
  principals: Principal[],
  createdBy: string
): Promise<{ added: Principal[]; removed: Principal[] }> => {
  const existing = await tx.savedPanelShare.findMany({
    where: { savedPanelId },
  });
  const wanted = new Map(principals.map((p) => [key(p), p]));
  const have = new Map<string, Principal>(
    existing.map((s) => {
      const p = { type: s.principalType as PrincipalType, id: s.principalId };
      return [key(p), p];
    })
  );
  const added = [...wanted].filter(([k]) => !have.has(k)).map(([, p]) => p);
  const removed = [...have].filter(([k]) => !wanted.has(k)).map(([, p]) => p);
  if (removed.length > 0) {
    await tx.savedPanelShare.deleteMany({
      where: {
        savedPanelId,
        OR: removed.map((p) => ({ principalType: p.type, principalId: p.id })),
      },
    });
  }
  if (added.length > 0) {
    await tx.savedPanelShare.createMany({
      data: added.map((p) => ({
        savedPanelId,
        principalType: p.type,
        principalId: p.id,
        createdBy,
      })),
    });
  }
  return { added, removed };
};

export const listShares = (
  id: string,
  tx: Db = prisma
): Promise<SavedPanelShare[]> =>
  tx.savedPanelShare.findMany({
    where: { savedPanelId: id },
    orderBy: [{ createdAt: "asc" }, { principalId: "asc" }],
  });

/**
 * Hands it to `newOwnerId`. `keepAccessFor` (the previous owner) gets a user
 * share so they keep reading it, or null for none. A share the new owner held
 * is dropped, as an owner needs none.
 */
export const transfer = async (
  tx: Db,
  id: string,
  newOwnerId: string,
  keepAccessFor: string | null
): Promise<SavedPanel> => {
  const updated = await tx.savedPanel.update({
    where: { id },
    data: { ownerId: newOwnerId },
  });
  await tx.savedPanelShare.deleteMany({
    where: { savedPanelId: id, principalType: "user", principalId: newOwnerId },
  });
  if (keepAccessFor !== null && keepAccessFor !== newOwnerId) {
    await tx.savedPanelShare.upsert({
      where: {
        savedPanelId_principalType_principalId: {
          savedPanelId: id,
          principalType: "user",
          principalId: keepAccessFor,
        },
      },
      create: {
        savedPanelId: id,
        principalType: "user",
        principalId: keepAccessFor,
        createdBy: newOwnerId,
      },
      update: {},
    });
  }
  return updated;
};

/** Those of `ids` that exist, in one read. */
export const findByIds = (
  ids: readonly string[],
  tx: Db = prisma
): Promise<SavedPanel[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : tx.savedPanel.findMany({ where: { id: { in: [...ids] } } });

/** Those of `ids` shared with the user or with one of `groupIds`, in one read. */
export const sharedWithAmong = async (
  ids: readonly string[],
  userId: string,
  groupIds: readonly string[],
  tx: Db = prisma
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const shares = await tx.savedPanelShare.findMany({
    where: {
      savedPanelId: { in: [...ids] },
      OR: [
        { principalType: "user", principalId: userId },
        ...(groupIds.length > 0
          ? [
              {
                principalType: "group" as const,
                principalId: { in: [...groupIds] },
              },
            ]
          : []),
      ],
    },
    select: { savedPanelId: true },
  });
  return new Set(shares.map((s) => s.savedPanelId));
};
