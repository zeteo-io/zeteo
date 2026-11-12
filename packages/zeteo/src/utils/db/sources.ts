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
