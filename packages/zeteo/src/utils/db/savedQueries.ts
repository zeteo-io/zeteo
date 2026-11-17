import { prisma, type Prisma } from "./prisma.js";
import type { Principal } from "./grants.js";
import type {
  PrincipalType,
  SavedQuery,
  SavedQueryShare,
} from "../../../prisma/generated/client/index.js";

/** The client or the open transaction a repository function runs on. */
type Db = Prisma.TransactionClient | typeof prisma;

/** A saved query with the two things that depend on who is asking: when they last ran it, and when it was shared with them. */
export type SavedQueryRow = SavedQuery & {
  userLastRunAt: Date | null;
  sharedAt: Date | null;
};

export interface SavedQueryInput {
  ownerId: string;
  sourceId: string;
  name: string;
  description: string;
  query: Prisma.InputJsonValue;
}

export type SavedQueryChanges = Partial<
  Pick<SavedQueryInput, "name" | "description" | "query" | "sourceId">
>;

const nameFilter = (q: string | undefined) =>
  q ? { name: { contains: q, mode: "insensitive" as const } } : {};

export const findById = (
  id: string,
  tx: Db = prisma
): Promise<SavedQuery | null> => tx.savedQuery.findUnique({ where: { id } });

/**
 * One page, newest first (ids are time-ordered), starting after the `cursor` id.
 * `"mine"` is what `userId` owns; `"shared"` is what is shared with the user or
 * with any of their groups, never what they own. `userLastRunAt` is the user's
 * own last run; `sharedAt` the earliest share that reaches them.
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
): Promise<{ rows: SavedQueryRow[]; hasMore: boolean }> => {
  const { userId, groupIds, scope, q, cursor, limit } = options;
  const reaching: Prisma.SavedQueryShareWhereInput = {
    OR: [
      { principalType: "user", principalId: userId },
      ...(groupIds.length > 0
        ? [{ principalType: "group" as const, principalId: { in: groupIds } }]
        : []),
    ],
  };
  const found = await tx.savedQuery.findMany({
    where: {
      ...(scope === "mine"
        ? { ownerId: userId }
        : { ownerId: { not: userId }, shares: { some: reaching } }),
      ...nameFilter(q),
      ...(cursor && { id: { lt: cursor } }),
    },
    include: {
      userRuns: { where: { userId }, select: { lastRunAt: true } },
      shares: {
        where: reaching,
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  const rows = found.slice(0, limit).map(({ userRuns, shares, ...row }) => ({
    ...row,
    userLastRunAt: userRuns[0]?.lastRunAt ?? null,
    sharedAt: shares[0]?.createdAt ?? null,
  }));
  return { rows, hasMore: found.length > limit };
};

/** Every saved query, optionally narrowed, newest first, after the `cursor` id. */
export const listAll = async (
  options: {
    ownerId?: string;
    sourceId?: string;
    sharedWith?: Principal;
    q?: string;
    cursor?: string;
    limit: number;
  },
  tx: Db = prisma
): Promise<{ rows: SavedQuery[]; hasMore: boolean }> => {
  const { ownerId, sourceId, sharedWith, q, cursor, limit } = options;
  const rows = await tx.savedQuery.findMany({
    where: {
      ...(ownerId && { ownerId }),
      ...(sourceId && { sourceId }),
      ...(sharedWith && {
        shares: {
          some: {
            principalType: sharedWith.type,
            principalId: sharedWith.id,
          },
        },
      }),
      ...nameFilter(q),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

export const create = (
  data: SavedQueryInput,
  tx: Db = prisma
): Promise<SavedQuery> => tx.savedQuery.create({ data });

export const update = (
  id: string,
  data: SavedQueryChanges,
  tx: Db = prisma
): Promise<SavedQuery> => tx.savedQuery.update({ where: { id }, data });

/** Deletes the saved query; its shares and user runs go with it, and the runs that came from it keep their record with no link. */
export const remove = (id: string, tx: Db = prisma): Promise<SavedQuery> =>
  tx.savedQuery.delete({ where: { id } });

export const listShares = (
  id: string,
  tx: Db = prisma
): Promise<SavedQueryShare[]> =>
  tx.savedQueryShare.findMany({
    where: { savedQueryId: id },
    orderBy: [{ createdAt: "asc" }, { principalId: "asc" }],
  });

/** How many shares each saved query has, by id; one with none is 0. */
export const countShares = async (
  ids: readonly string[],
  tx: Db = prisma
): Promise<Map<string, number>> => {
  const counts = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;
  const grouped = await tx.savedQueryShare.groupBy({
    by: ["savedQueryId"],
    where: { savedQueryId: { in: [...ids] } },
    _count: { _all: true },
  });
  for (const g of grouped) counts.set(g.savedQueryId, g._count._all);
  return counts;
};

const key = (p: Principal) => `${p.type}:${p.id}`;

/** Makes the shares exactly `principals`; resolves who was added and who removed. Shares already there keep their `createdBy` and `createdAt`. */
export const replaceShares = async (
  tx: Db,
  savedQueryId: string,
  principals: Principal[],
  createdBy: string
): Promise<{ added: Principal[]; removed: Principal[] }> => {
  const existing = await tx.savedQueryShare.findMany({
    where: { savedQueryId },
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
    await tx.savedQueryShare.deleteMany({
      where: {
        savedQueryId,
        OR: removed.map((p) => ({
          principalType: p.type,
          principalId: p.id,
        })),
      },
    });
  }
  if (added.length > 0) {
    await tx.savedQueryShare.createMany({
      data: added.map((p) => ({
        savedQueryId,
        principalType: p.type,
        principalId: p.id,
        createdBy,
      })),
    });
  }
  return { added, removed };
};

/**
 * Hands the saved query to `newOwnerId`. `keepAccessFor` (the previous owner)
 * gets a user share so they keep reading it, or null for none. A share the new
 * owner held is dropped, as an owner needs none.
 */
export const transfer = async (
  tx: Db,
  id: string,
  newOwnerId: string,
  keepAccessFor: string | null
): Promise<SavedQuery> => {
  const updated = await tx.savedQuery.update({
    where: { id },
    data: { ownerId: newOwnerId },
  });
  await tx.savedQueryShare.deleteMany({
    where: {
      savedQueryId: id,
      principalType: "user",
      principalId: newOwnerId,
    },
  });
  if (keepAccessFor !== null && keepAccessFor !== newOwnerId) {
    await tx.savedQueryShare.upsert({
      where: {
        savedQueryId_principalType_principalId: {
          savedQueryId: id,
          principalType: "user",
          principalId: keepAccessFor,
        },
      },
      create: {
        savedQueryId: id,
        principalType: "user",
        principalId: keepAccessFor,
        createdBy: newOwnerId,
      },
      update: {},
    });
  }
  return updated;
};

/** Records a run: the saved query's own last run and the user's. */
export const stampRun = async (
  savedQueryId: string,
  userId: string,
  at: Date,
  tx?: Prisma.TransactionClient
): Promise<void> => {
  const run = async (db: Db) => {
    // Raw, so `updated_at` (when it was last edited) stays as it is, and a
    // saved query deleted meanwhile is skipped, not an error.
    await db.$executeRaw`UPDATE "zeteo"."saved_queries" SET last_run_at = ${at} WHERE id = ${savedQueryId}::uuid`;
    await db.$executeRaw`INSERT INTO "zeteo"."saved_query_user_runs" (saved_query_id, user_id, last_run_at)
      SELECT id, ${userId}::uuid, ${at} FROM "zeteo"."saved_queries" WHERE id = ${savedQueryId}::uuid
      ON CONFLICT (saved_query_id, user_id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`;
  };
  if (tx) await run(tx);
  else await prisma.$transaction((t) => run(t));
};

const reaching = (
  userId: string,
  groupIds: readonly string[]
): Prisma.SavedQueryShareWhereInput => ({
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
});

/** `rows` with what depends on `userId`: their own last run, and the earliest share that reaches them (null for none). */
export const withViewer = async (
  rows: SavedQuery[],
  userId: string,
  groupIds: readonly string[],
  tx: Db = prisma
): Promise<SavedQueryRow[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [runs, shares] = await Promise.all([
    tx.savedQueryUserRun.findMany({
      where: { userId, savedQueryId: { in: ids } },
      select: { savedQueryId: true, lastRunAt: true },
    }),
    tx.savedQueryShare.findMany({
      where: { savedQueryId: { in: ids }, ...reaching(userId, groupIds) },
      select: { savedQueryId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const ran = new Map(runs.map((r) => [r.savedQueryId, r.lastRunAt]));
  const shared = new Map<string, Date>();
  for (const s of shares) {
    if (!shared.has(s.savedQueryId)) shared.set(s.savedQueryId, s.createdAt);
  }
  return rows.map((row) => ({
    ...row,
    userLastRunAt: ran.get(row.id) ?? null,
    sharedAt: shared.get(row.id) ?? null,
  }));
};

/** Whether the saved query is shared with the user, or with one of `groupIds`. */
export const isSharedWith = async (
  id: string,
  userId: string,
  groupIds: readonly string[],
  tx: Db = prisma
): Promise<boolean> =>
  (await tx.savedQueryShare.count({
    where: { savedQueryId: id, ...reaching(userId, groupIds) },
  })) > 0;
