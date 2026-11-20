import { Prisma as PrismaRuntime } from "../../prisma/generated/client/index.js";
import { GRANTS_WRITE, AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import type { PrincipalType } from "../../prisma/generated/client/index.js";
import { detailInclude, type GrantDetail } from "../utils/db/grants.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { assertOwnsInTx } from "../uploads/ownership.js";
import type { RuleFilter } from "../row-rules/types.js";
import { db, type Prisma } from "../utils/db/index.js";
import { toStoredRule } from "../row-rules/store.js";
import { withAudit } from "../utils/transaction.js";
import type { Caller } from "../middleware/auth.js";
import {
  ConflictError,
  InvalidGrantError,
  NotFoundError,
  OwnerGrantLockedError,
  SourceArchivedError,
} from "../utils/errors.js";

/** What a grant lets its principal read of the table: every column, now and later, or a list. */
export type GrantColumns =
  { allColumns: true } | { allColumns: false; columnIds: string[] };

/**
 * What a grant lets its principal read of the table's rows: no limit of its
 * own (`unlimited_default`), every row (`all`), or the rows a rule matches.
 */
export type GrantRows =
  | { access: "unlimited_default" | "all" }
  | { access: "rule"; rule: RuleFilter; description?: string };

/** A grant's columns and rows: what a create sets and a replace replaces. */
export interface GrantAccess {
  columns: GrantColumns;
  rows: GrantRows;
}

export interface CreateGrantInput extends GrantAccess {
  principalType: PrincipalType;
  principalId: string;
  tableId: string;
}

/**
 * Who changes grants: `actorId`, and `owner` when they act as the owner of
 * the table's upload source rather than as a holder of `zeteo.grants.write`
 * (checked again in the transaction, against a transfer meanwhile).
 */
export interface GrantActor {
  actorId: string;
  owner?: Caller;
}

const checkOwner = async (
  tx: Prisma.TransactionClient,
  actor: GrantActor,
  sourceId: string
) => {
  if (actor.owner) {
    await assertOwnsInTx(tx, actor.owner, sourceId, GRANTS_WRITE);
  }
};

/**
 * Locks the grant's row (`FOR UPDATE`) for a change; the 404 when there is
 * none. An owner's source is locked and checked first (`checkOwner`), in the
 * order a transfer takes them: the source, then its grants. A grant's table,
 * and so its source, never changes, so it is read before either lock.
 */
const lockGrant = async (
  tx: Prisma.TransactionClient,
  id: string,
  actor: GrantActor
): Promise<void> => {
  if (actor.owner) {
    const found = await tx.grant.findUnique({
      where: { id },
      select: { table: { select: { sourceId: true } } },
    });
    if (!found) throw new NotFoundError("Grant not found");
    await checkOwner(tx, actor, found.table.sourceId);
  }
  const locked = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "zeteo"."grants" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError("Grant not found");
};

const grantExists = () =>
  new ConflictError(
    "This principal already has a grant on the table; replace it instead",
    "grant_exists"
  );

/** The audit metadata of a grant as it stands (or stood, for a removal); the rule in its stored form. */
const auditMetadata = (grant: {
  principalType: PrincipalType;
  principalId: string;
  tableId: string;
  allColumns: boolean;
  sourceId: string;
  columnIds: string[];
  rowAccess: string;
  rowRule: Prisma.JsonValue;
  rowRuleDescription: string | null;
}) => ({
  source_id: grant.sourceId,
  table_id: grant.tableId,
  principal_type: grant.principalType,
  principal_id: grant.principalId,
  all_columns: grant.allColumns,
  column_ids: grant.columnIds,
  row_access: grant.rowAccess,
  row_rule: grant.rowRule,
  row_rule_description: grant.rowRuleDescription,
});

/**
 * The grant's row columns for `rows`: the rule checked against the table and
 * stored by id (its identity keys locked, see `toStoredRule`), or cleared.
 */
const rowData = async (
  tx: Prisma.TransactionClient,
  tableId: string,
  rows: GrantRows
) => {
  if (rows.access !== "rule") {
    return {
      rowAccess: rows.access,
      rowRule: PrismaRuntime.DbNull,
      rowRuleDescription: null,
      identityKeyIds: [],
    };
  }
  const { stored, identityKeyIds } = await toStoredRule(tx, tableId, rows.rule);
  return {
    rowAccess: rows.access,
    rowRule: stored as Prisma.InputJsonValue,
    rowRuleDescription: rows.description ?? null,
    identityKeyIds,
  };
};

/** An owner grant shows every column and does not limit rows (`owner_grant_locked`). */
const checkOwnerGrant = (ownerGrant: boolean, access: GrantAccess) => {
  if (
    ownerGrant &&
    (!access.columns.allColumns || access.rows.access !== "unlimited_default")
  ) {
    throw new OwnerGrantLockedError();
  }
};

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
  { actorId, ...actor }: GrantActor
): Promise<GrantDetail> =>
  withAudit(async (tx, audit) => {
    const table = await tx.sourceTable.findUnique({
      where: { id: input.tableId },
      include: { source: { select: { archivedAt: true } } },
    });
    if (!table) throw new NotFoundError("Table not found");
    await checkOwner(tx, { actorId, ...actor }, table.sourceId);
    if (table.source.archivedAt) throw new SourceArchivedError();
    const columnIds = await checkedColumnIds(tx, table.id, input.columns);
    const rows = await rowData(tx, table.id, input.rows);

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
            ...rows,
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

/**
 * Replaces the grant's columns and rows, all of them: an owner grant may not
 * be narrowed nor given row access of its own (`owner_grant_locked`), whoever
 * asks.
 */
export const replaceGrant = async (
  id: string,
  { columns, rows: wanted }: GrantAccess,
  { actorId, ...actor }: GrantActor
): Promise<GrantDetail> =>
  withAudit(async (tx, audit) => {
    // Concurrent replaces take turns: each deletes and recreates the columns.
    await lockGrant(tx, id, { actorId, ...actor });
    const grant = await tx.grant.findUnique({
      where: { id },
      include: { table: { include: { source: true } } },
    });
    if (!grant) throw new NotFoundError("Grant not found");
    if (grant.table.source.archivedAt) throw new SourceArchivedError();
    checkOwnerGrant(grant.ownerGrant, { columns, rows: wanted });
    const columnIds = await checkedColumnIds(tx, grant.tableId, columns);
    const rows = await rowData(tx, grant.tableId, wanted);

    await tx.grantColumn.deleteMany({ where: { grantId: id } });
    await tx.grantColumn.createMany({
      data: columnIds.map((columnId) => ({ grantId: id, columnId })),
    });
    const updated = await tx.grant.update({
      where: { id },
      data: { allColumns: columns.allColumns, ...rows },
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

/** Removes the grant; an owner grant may not be removed (`owner_grant_locked`), whoever asks. */
export const removeGrant = async (
  id: string,
  { actorId, ...actor }: GrantActor
): Promise<void> => {
  await withAudit(async (tx, audit) => {
    // Locked first, so a transfer flagging it meanwhile is seen here.
    await lockGrant(tx, id, { actorId, ...actor });
    const grant = await tx.grant.findUnique({
      where: { id },
      include: { table: { select: { sourceId: true } }, columns: true },
    });
    if (!grant) throw new NotFoundError("Grant not found");
    if (grant.ownerGrant) throw new OwnerGrantLockedError();
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
