import type { Source } from "../../../prisma/generated/client/index.js";
import { prisma, type Prisma } from "./prisma.js";

export const create = (
  data: Prisma.SourceUncheckedCreateInput
): Promise<Source> => prisma.source.create({ data });

export const findById = (id: string): Promise<Source | null> =>
  prisma.source.findUnique({ where: { id } });

export const findBySlug = (slug: string): Promise<Source | null> =>
  prisma.source.findUnique({ where: { slug } });

/** Archived sources are left out unless `includeArchived`. */
export const list = (includeArchived = false): Promise<Source[]> =>
  prisma.source.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: "asc" },
  });

export const update = (
  id: string,
  data: Prisma.SourceUncheckedUpdateInput
): Promise<Source> => prisma.source.update({ where: { id }, data });

export const archive = (id: string): Promise<Source> =>
  prisma.source.update({ where: { id }, data: { archivedAt: new Date() } });

/** One page in creation order (`created_at`, then `id`), starting after `after`; `hasMore` says whether another page follows. */
export const listPage = async (options: {
  includeArchived: boolean;
  limit: number;
  after?: { createdAt: Date; id: string };
}): Promise<{ rows: Source[]; hasMore: boolean }> => {
  const { includeArchived, limit, after } = options;
  const rows = await prisma.source.findMany({
    where: {
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(after && {
        OR: [
          { createdAt: { gt: after.createdAt } },
          { createdAt: after.createdAt, id: { gt: after.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

/** Unarchived sources never refreshed or last refreshed before `olderThan`, the longest-waiting first. */
export const listDueForRefresh = (olderThan: Date): Promise<Source[]> =>
  prisma.source.findMany({
    where: {
      archivedAt: null,
      OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: olderThan } }],
    },
    orderBy: [
      { lastRefreshedAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
  });
