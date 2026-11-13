import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { withAudit } from "../utils/transaction.js";
import type { Prisma } from "../utils/db/prisma.js";
import { lockSourceCatalog } from "./lock.js";
import { typeOf } from "../sources/types.js";
import type {
  Relation,
  Source,
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";
import {
  ConflictError,
  InvalidRelationError,
  NotFoundError,
  SourceArchivedError,
  ValidationError,
} from "../utils/errors.js";

export interface TableDetail {
  table: SourceTable;
  columns: SourceColumn[];
  relations: Relation[];
}

export interface DescribeTableInput {
  /** `null` clears the description. */
  description?: string | null;
  columns?: Array<{ name: string; description: string | null }>;
}

export interface DeclareRelationInput {
  name: string;
  fromTableId: string;
  fromColumns: string[];
  toTableId: string;
  toColumns: string[];
  toMany: boolean;
}

const requireActiveSource = async (
  tx: Prisma.TransactionClient,
  sourceId: string
): Promise<Source> => {
  const source = await tx.source.findUnique({ where: { id: sourceId } });
  if (!source) throw new NotFoundError("Source not found");
  if (source.archivedAt) throw new SourceArchivedError();
  return source;
};

const detailOf = async (
  tx: Prisma.TransactionClient,
  table: SourceTable
): Promise<TableDetail> => ({
  table,
  columns: await tx.sourceColumn.findMany({
    where: { tableId: table.id },
    orderBy: { position: "asc" },
  }),
  relations: await tx.relation.findMany({
    where: { fromTableId: table.id },
    orderBy: { name: "asc" },
  }),
});

/** Sets descriptions on a table and its columns; anything the input leaves out stays as it is. */
export const describeTable = async (
  sourceId: string,
  tableId: string,
  input: DescribeTableInput,
  actorId: string
): Promise<TableDetail> =>
  withAudit(async (tx, audit) => {
    const source = await requireActiveSource(tx, sourceId);
    const found = await tx.sourceTable.findFirst({
      where: { id: tableId, sourceId },
    });
    if (!found) throw new NotFoundError("Table not found");

    if (input.columns) {
      const known = await tx.sourceColumn.findMany({
        where: { tableId, name: { in: input.columns.map((c) => c.name) } },
        select: { id: true, name: true },
      });
      const idByName = new Map(known.map((c) => [c.name, c.id]));
      const issues = input.columns.flatMap((c, i) =>
        idByName.has(c.name)
          ? []
          : [{ path: `columns.${i}.name`, message: "No such column" }]
      );
      if (issues.length > 0) {
        throw new ValidationError(
          `Invalid request body. ${issues.map((i) => `${i.path}: ${i.message}`).join(", ")}`,
          issues
        );
      }
      for (const column of input.columns) {
        await tx.sourceColumn.update({
          where: { id: idByName.get(column.name)! },
          data: { description: column.description },
        });
      }
    }
    const table =
      input.description === undefined
        ? found
        : await tx.sourceTable.update({
            where: { id: tableId },
            data: { description: input.description },
          });

    audit({
      action: AUDIT_EVENTS.sourceUpdated,
      resourceType: "source",
      resourceId: sourceId,
      actorId,
      metadata: {
        slug: source.slug,
        type: typeOf(source),
        table_id: tableId,
        table: `${found.schemaName}.${found.name}`,
        changed: [
          ...(input.description !== undefined ? ["description"] : []),
          ...(input.columns ? ["columns"] : []),
        ],
      },
    });
    return detailOf(tx, table);
  });

/** Columns a relation may join on: present, and of one comparable type on both sides. */
const checkJoin = (
  input: DeclareRelationInput,
  fromColumns: SourceColumn[],
  toColumns: SourceColumn[]
): void => {
  if (input.fromColumns.length !== input.toColumns.length) {
    throw new InvalidRelationError(
      "from_columns and to_columns must have the same number of columns"
    );
  }
  for (const [side, names] of [
    ["from_columns", input.fromColumns],
    ["to_columns", input.toColumns],
  ] as const) {
    if (new Set(names).size !== names.length) {
      throw new InvalidRelationError(`${side} lists a column twice`);
    }
  }
  input.fromColumns.forEach((fromName, i) => {
    const toName = input.toColumns[i];
    const from = fromColumns.find((c) => c.name === fromName);
    const to = toColumns.find((c) => c.name === toName);
    if (!from || from.missingSince) {
      throw new InvalidRelationError(
        `from_columns: ${fromName} is not a column of the from table that is present in the source`
      );
    }
    if (!to || to.missingSince) {
      throw new InvalidRelationError(
        `to_columns: ${toName} is not a column of the to table that is present in the source`
      );
    }
    if (from.type !== to.type) {
      throw new InvalidRelationError(
        `${fromName} (${from.type}) and ${toName} (${to.type}) have different types`
      );
    }
    if (from.type === "other" || from.type === "json") {
      throw new InvalidRelationError(
        `${fromName} and ${toName} have type ${from.type}, which cannot be joined on`
      );
    }
  });
};

export const declareRelation = async (
  sourceId: string,
  input: DeclareRelationInput,
  actorId: string
): Promise<Relation> =>
  withAudit(async (tx, audit) => {
    await lockSourceCatalog(tx, sourceId);
    const source = await requireActiveSource(tx, sourceId);
    const tables = await tx.sourceTable.findMany({
      where: { sourceId, id: { in: [input.fromTableId, input.toTableId] } },
      select: { id: true },
    });
    const has = (id: string) => tables.some((t) => t.id === id);
    if (!has(input.fromTableId)) {
      throw new InvalidRelationError(
        "from_table_id is not a table of this source"
      );
    }
    if (!has(input.toTableId)) {
      throw new InvalidRelationError(
        "to_table_id is not a table of this source"
      );
    }
    const [fromColumns, toColumns] = await Promise.all([
      tx.sourceColumn.findMany({ where: { tableId: input.fromTableId } }),
      tx.sourceColumn.findMany({ where: { tableId: input.toTableId } }),
    ]);
    checkJoin(input, fromColumns, toColumns);

    const taken = () =>
      new ConflictError(
        "The from table already has a relation with this name",
        "relation_name_taken"
      );
    if (
      await tx.relation.findFirst({
        where: { fromTableId: input.fromTableId, name: input.name },
        select: { id: true },
      })
    ) {
      throw taken();
    }
    const relation = await mapUniqueViolation(
      () =>
        tx.relation.create({
          data: {
            sourceId,
            name: input.name,
            fromTableId: input.fromTableId,
            fromColumns: input.fromColumns,
            toTableId: input.toTableId,
            toColumns: input.toColumns,
            toMany: input.toMany,
            origin: "declared",
            createdBy: actorId,
          },
        }),
      taken().message,
      "relation_name_taken"
    );
    audit({
      action: AUDIT_EVENTS.relationDeclared,
      resourceType: "relation",
      resourceId: relation.id,
      actorId,
      metadata: {
        source_id: sourceId,
        slug: source.slug,
        name: relation.name,
        from_table_id: relation.fromTableId,
        to_table_id: relation.toTableId,
      },
    });
    return relation;
  });

/** Removes a declared relation; a discovered one comes from a foreign key and stays. */
export const removeRelation = async (
  sourceId: string,
  relationId: string,
  actorId: string
): Promise<void> => {
  await withAudit(async (tx, audit) => {
    await lockSourceCatalog(tx, sourceId);
    const source = await requireActiveSource(tx, sourceId);
    const relation = await tx.relation.findFirst({
      where: { id: relationId, sourceId },
    });
    if (!relation) throw new NotFoundError("Relation not found");
    if (relation.origin !== "declared") {
      throw new ConflictError(
        "A discovered relation comes from a foreign key and cannot be removed",
        "relation_discovered"
      );
    }
    const { count } = await tx.relation.deleteMany({
      where: { id: relationId, origin: "declared" },
    });
    if (count === 0) throw new NotFoundError("Relation not found");
    audit({
      action: AUDIT_EVENTS.relationRemoved,
      resourceType: "relation",
      resourceId: relationId,
      actorId,
      metadata: {
        source_id: sourceId,
        slug: source.slug,
        name: relation.name,
      },
    });
  });
};
