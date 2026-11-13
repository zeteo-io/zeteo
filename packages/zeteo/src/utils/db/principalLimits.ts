import type { PrincipalLimit } from "../../../prisma/generated/client/index.js";
import type { PrincipalType } from "../../../prisma/generated/client/index.js";
import type { Principal } from "./grants.js";
import { prisma } from "./prisma.js";

export const findById = (id: string): Promise<PrincipalLimit | null> =>
  prisma.principalLimit.findUnique({ where: { id } });

/** The limit rows of any of the principals, in one query. */
export const listForPrincipals = (
  principals: Principal[]
): Promise<PrincipalLimit[]> =>
  principals.length === 0
    ? Promise.resolve([])
    : prisma.principalLimit.findMany({
        where: {
          OR: principals.map((p) => ({
            principalType: p.type,
            principalId: p.id,
          })),
        },
      });

/** One page in `id` order (creation order), starting after the `cursor` id; `hasMore` says whether another page follows. */
export const listPage = async (options: {
  principalType?: PrincipalType;
  principalId?: string;
  cursor?: string;
  limit: number;
}): Promise<{ rows: PrincipalLimit[]; hasMore: boolean }> => {
  const { principalType, principalId, cursor, limit } = options;
  const rows = await prisma.principalLimit.findMany({
    where: {
      ...(principalType && { principalType }),
      ...(principalId && { principalId }),
      ...(cursor && { id: { gt: cursor } }),
    },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};
