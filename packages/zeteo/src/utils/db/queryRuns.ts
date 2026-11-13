import { prisma } from "./prisma.js";
import type {
  QueryRun,
  RunOutcome,
} from "../../../prisma/generated/client/index.js";

/** One page newest first (ids are time-ordered), starting after the `cursor` id; `hasMore` says whether another page follows. */
export const listPage = async (options: {
  userId?: string;
  sourceId?: string;
  outcome?: RunOutcome;
  cursor?: string;
  limit: number;
}): Promise<{ rows: QueryRun[]; hasMore: boolean }> => {
  const { userId, sourceId, outcome, cursor, limit } = options;
  const rows = await prisma.queryRun.findMany({
    where: {
      ...(userId && { userId }),
      ...(sourceId && { sourceId }),
      ...(outcome && { outcome }),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

/** Exports still `running` that started before `cutoff`, oldest first, after the `after` id. */
export const listRunningExportsBefore = (
  cutoff: Date,
  after: string | undefined,
  limit: number
) =>
  prisma.queryRun.findMany({
    where: {
      outcome: "running",
      entryPoint: "export",
      createdAt: { lt: cutoff },
      sourceId: { not: null },
      ...(after && { id: { gt: after } }),
    },
    orderBy: { id: "asc" },
    take: limit,
  });

/** Deletes up to `limit` runs created before `cutoff`, never a `running` one; resolves how many. */
export const deleteFinishedBefore = async (
  cutoff: Date,
  limit: number
): Promise<number> => {
  const ids = await prisma.queryRun.findMany({
    where: { createdAt: { lt: cutoff }, outcome: { not: "running" } },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });
  if (ids.length === 0) return 0;
  const { count } = await prisma.queryRun.deleteMany({
    where: { id: { in: ids.map((r) => r.id) }, outcome: { not: "running" } },
  });
  return count;
};
