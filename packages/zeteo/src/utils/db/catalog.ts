import { prisma, type Prisma } from "./prisma.js";
import type {
  Relation,
  SourceColumn,
  SourceTable,
} from "../../../prisma/generated/client/index.js";

export const createTable = (
  data: Prisma.SourceTableUncheckedCreateInput
): Promise<SourceTable> => prisma.sourceTable.create({ data });

export const listTables = (sourceId: string): Promise<SourceTable[]> =>
  prisma.sourceTable.findMany({
    where: { sourceId },
    orderBy: [{ schemaName: "asc" }, { name: "asc" }],
  });

export const createColumn = (
  data: Prisma.SourceColumnUncheckedCreateInput
): Promise<SourceColumn> => prisma.sourceColumn.create({ data });

export const listColumns = (tableId: string): Promise<SourceColumn[]> =>
  prisma.sourceColumn.findMany({
    where: { tableId },
    orderBy: { position: "asc" },
  });

export const createRelation = (
  data: Prisma.RelationUncheckedCreateInput
): Promise<Relation> => prisma.relation.create({ data });

export const listRelations = (sourceId: string): Promise<Relation[]> =>
  prisma.relation.findMany({ where: { sourceId }, orderBy: { name: "asc" } });
