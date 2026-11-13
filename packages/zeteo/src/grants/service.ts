import type { PrincipalType } from "../../prisma/generated/client/index.js";
import { detailInclude, type GrantDetail } from "../utils/db/grants.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { db, type Prisma } from "../utils/db/index.js";
import { withAudit } from "../utils/transaction.js";
import {
  ConflictError,
  InvalidGrantError,
  NotFoundError,
  SourceArchivedError,
} from "../utils/errors.js";

/** What a grant lets its principal read of the table: every column, now and later, or a list. */
export type GrantColumns =
  { allColumns: true } | { allColumns: false; columnIds: string[] };

export interface CreateGrantInput {
  principalType: PrincipalType;
  principalId: string;
  tableId: string;
  columns: GrantColumns;
}

const grantExists = () =>
  new ConflictError(
    "This principal already has a grant on the table; replace its columns instead",
    "grant_exists"
  );

/** The audit metadata of a grant as it stands (or stood, for a removal). */
const auditMetadata = (grant: {
  principalType: PrincipalType;
  principalId: string;
  tableId: string;
  allColumns: boolean;
  sourceId: string;
  columnIds: string[];
}) => ({
  source_id: grant.sourceId,
  table_id: grant.tableId,
  principal_type: grant.principalType,
  principal_id: grant.principalId,
  all_columns: grant.allColumns,
  column_ids: grant.columnIds,
});

/** The ids of `columns` when it is a list of columns that all belong to `tableId`. */
const checkedColumnIds = async (
  tx: Prisma.TransactionClient,
  tableId: string,
  columns: GrantColumns
): Promise<string[]> => {
  if (columns.allColumns) return [];
  const found = await tx.sourceColumn.count({
    where: { tableId, id: { in: columns.columnIds } },
  });
  if (found !== columns.columnIds.length) {
    throw new InvalidGrantError(
      "column_ids names a column that is not a column of the table"
    );
  }
  return columns.columnIds;
};

const detailOrThrow = (
  tx: Prisma.TransactionClient,
  id: string
): Promise<GrantDetail> =>
  tx.grant.findUniqueOrThrow({ where: { id }, include: detailInclude });

export const createGrant = async (
  input: CreateGrantInput,
  actorId: string
): Promise<GrantDetail> =>
  withAudit(async (tx, audit) => {
    const table = await tx.sourceTable.findUnique({
      where: { id: input.tableId },
      include: { source: { select: { archivedAt: true } } },
    });
    if (!table) throw new NotFoundError("Table not found");
    if (table.source.archivedAt) throw new SourceArchivedError();
    const columnIds = await checkedColumnIds(tx, table.id, input.columns);

    const taken = await tx.grant.findFirst({
      where: {
        principalType: input.principalType,
        principalId: input.principalId,
        tableId: table.id,
      },
      select: { id: true },
    });
    if (taken) throw grantExists();
    const created = await mapUniqueViolation(
      () =>
        tx.grant.create({
          data: {
            principalType: input.principalType,
            principalId: input.principalId,
            tableId: table.id,
            allColumns: input.columns.allColumns,
            createdBy: actorId,
            columns: {
              create: columnIds.map((columnId) => ({ columnId })),
            },
          },
        }),
      grantExists().message,
      "grant_exists"
    );
    audit({
      action: AUDIT_EVENTS.grantCreated,
      resourceType: "grant",
      resourceId: created.id,
      actorId,
      metadata: auditMetadata({
        ...created,
        sourceId: table.sourceId,
        columnIds,
      }),
    });
    return detailOrThrow(tx, created.id);
  });

/** Replaces the grant's columns: all of them, or exactly this list. */
export const replaceGrantColumns = async (
  id: string,
  columns: GrantColumns,
  actorId: string
): Promise<GrantDetail> =>
  withAudit(async (tx, audit) => {
    const grant = await tx.grant.findUnique({
      where: { id },
      include: { table: { include: { source: true } } },
    });
    if (!grant) throw new NotFoundError("Grant not found");
    if (grant.table.source.archivedAt) throw new SourceArchivedError();
    const columnIds = await checkedColumnIds(tx, grant.tableId, columns);

    await tx.grantColumn.deleteMany({ where: { grantId: id } });
    await tx.grantColumn.createMany({
      data: columnIds.map((columnId) => ({ grantId: id, columnId })),
    });
    const updated = await tx.grant.update({
      where: { id },
      data: { allColumns: columns.allColumns },
    });
    audit({
      action: AUDIT_EVENTS.grantUpdated,
      resourceType: "grant",
      resourceId: id,
      actorId,
      metadata: auditMetadata({
        ...updated,
        sourceId: grant.table.sourceId,
        columnIds,
      }),
    });
    return detailOrThrow(tx, id);
  });

export const removeGrant = async (
  id: string,
  actorId: string
): Promise<void> => {
  await withAudit(async (tx, audit) => {
    const grant = await tx.grant.findUnique({
      where: { id },
      include: { table: { select: { sourceId: true } }, columns: true },
    });
    if (!grant) throw new NotFoundError("Grant not found");
    // Its columns go with it (ON DELETE CASCADE).
    await tx.grant.delete({ where: { id } });
    audit({
      action: AUDIT_EVENTS.grantRemoved,
      resourceType: "grant",
      resourceId: id,
      actorId,
      metadata: auditMetadata({
        ...grant,
        sourceId: grant.table.sourceId,
        columnIds: grant.columns.map((c) => c.columnId),
      }),
    });
  });
};

export const getGrant = async (id: string): Promise<GrantDetail> => {
  const row = await db.grants.findDetailById(id);
  if (!row) throw new NotFoundError("Grant not found");
  return row;
};
