import { prisma } from "./prisma.js";
import type {
  QueryRun,
  RunOutcome,
} from "../../../prisma/generated/client/index.js";

/** One page in `id` order (creation order), starting after the `cursor` id; `hasMore` says whether another page follows. */
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
      ...(cursor && { id: { gt: cursor } }),
    },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};
