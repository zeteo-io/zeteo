import { prisma, type Prisma } from "./prisma.js";
import type {
  Grant,
  GrantColumn,
  PrincipalType,
} from "../../../prisma/generated/client/index.js";

export interface Principal {
  type: PrincipalType;
  id: string;
}

export type GrantWithColumns = Grant & {
  columns: GrantColumn[];
  table: { sourceId: string; source: { archivedAt: Date | null } };
};

const withColumns = {
  columns: true,
  table: {
    select: {
      sourceId: true,
      source: { select: { archivedAt: true } },
    },
  },
} as const;

/** What a grant's view shows: its columns in table order with their names, and its table with the source's slug. */
export const detailInclude = {
  columns: {
    include: { column: true },
    orderBy: { column: { position: "asc" } },
  },
  table: { include: { source: { select: { id: true, slug: true } } } },
} as const;

export type GrantDetail = Prisma.GrantGetPayload<{
  include: typeof detailInclude;
}>;

export const findById = (id: string): Promise<Grant | null> =>
  prisma.grant.findUnique({ where: { id } });

export const findDetailById = (id: string): Promise<GrantDetail | null> =>
  prisma.grant.findUnique({ where: { id }, include: detailInclude });

/** Every grant held by any of the principals, with its column ids and its table's source. */
export const listForPrincipals = (
  principals: Principal[]
): Promise<GrantWithColumns[]> =>
  principals.length === 0
    ? Promise.resolve([])
    : prisma.grant.findMany({
        where: {
          OR: principals.map((p) => ({
            principalType: p.type,
            principalId: p.id,
          })),
        },
        include: withColumns,
        orderBy: { id: "asc" },
      });

/** One page in `id` order (creation order), starting after the `cursor` id; `hasMore` says whether another page follows. */
export const listPage = async (options: {
  principalType?: PrincipalType;
  principalId?: string;
  tableId?: string;
  sourceId?: string;
  cursor?: string;
  limit: number;
}): Promise<{ rows: GrantDetail[]; hasMore: boolean }> => {
  const { principalType, principalId, tableId, sourceId, cursor, limit } =
    options;
  const rows = await prisma.grant.findMany({
    where: {
      ...(principalType && { principalType }),
      ...(principalId && { principalId }),
      ...(tableId && { tableId }),
      ...(sourceId && { table: { sourceId } }),
      ...(cursor && { id: { gt: cursor } }),
    },
    include: detailInclude,
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};
