import { prisma } from "./prisma.js";
import type {
  Relation,
  SourceColumn,
  SourceTable,
} from "../../../prisma/generated/client/index.js";

/** The table, only when it belongs to `sourceId`. */
export const findTable = (
  sourceId: string,
  tableId: string
): Promise<SourceTable | null> =>
  prisma.sourceTable.findFirst({ where: { id: tableId, sourceId } });

/** One page in `schema_name`, `name` order, starting after `after`; `hasMore` says whether another page follows. */
export const listTablesPage = async (options: {
  sourceId: string;
  includeMissing: boolean;
  limit: number;
  after?: { schemaName: string; name: string };
}): Promise<{ rows: SourceTable[]; hasMore: boolean }> => {
  const { sourceId, includeMissing, limit, after } = options;
  const rows = await prisma.sourceTable.findMany({
    where: {
      sourceId,
      ...(includeMissing ? {} : { missingSince: null }),
      ...(after && {
        OR: [
          { schemaName: { gt: after.schemaName } },
          { schemaName: after.schemaName, name: { gt: after.name } },
        ],
      }),
    },
    orderBy: [{ schemaName: "asc" }, { name: "asc" }],
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

export const listColumns = (tableId: string): Promise<SourceColumn[]> =>
  prisma.sourceColumn.findMany({
    where: { tableId },
    orderBy: { position: "asc" },
  });

/** The relations that start at `tableId`, by name. */
export const listRelationsFrom = (tableId: string): Promise<Relation[]> =>
  prisma.relation.findMany({
    where: { fromTableId: tableId },
    orderBy: { name: "asc" },
  });

/** One page in creation order (the ids are time-ordered), starting after `afterId`. */
export const listRelationsPage = async (options: {
  sourceId: string;
  limit: number;
  afterId?: string;
}): Promise<{ rows: Relation[]; hasMore: boolean }> => {
  const { sourceId, limit, afterId } = options;
  const rows = await prisma.relation.findMany({
    where: { sourceId, ...(afterId && { id: { gt: afterId } }) },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

/** Every table, column and relation of a source, missing ones included, in bulk. */
export const loadSourceCatalog = async (
  sourceId: string
): Promise<{
  tables: SourceTable[];
  columns: SourceColumn[];
  relations: Relation[];
}> => {
  const [tables, columns, relations] = await Promise.all([
    prisma.sourceTable.findMany({
      where: { sourceId },
      orderBy: [{ schemaName: "asc" }, { name: "asc" }],
    }),
    prisma.sourceColumn.findMany({
      where: { table: { sourceId } },
      orderBy: [{ tableId: "asc" }, { position: "asc" }],
    }),
    prisma.relation.findMany({ where: { sourceId }, orderBy: { name: "asc" } }),
  ]);
  return { tables, columns, relations };
};
