import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { withAudit } from "../utils/transaction.js";
import { db } from "../utils/db/index.js";
import type {
  PrincipalLimit,
  PrincipalType,
} from "../../prisma/generated/client/index.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";

export interface CreatePrincipalLimitInput {
  principalType: PrincipalType;
  principalId: string;
  /** At least one of the two is set. */
  queryConcurrency?: number;
  exportConcurrency?: number;
}

/** A change: a number sets the limit, null clears it, undefined leaves it. */
export interface UpdatePrincipalLimitInput {
  queryConcurrency?: number | null;
  exportConcurrency?: number | null;
}

const RESOURCE_TYPE = "principal_limit";

const limitsExist = () =>
  new ConflictError(
    "This principal already has its own limits; change them instead"
  );

const notFound = () => new NotFoundError("Principal limits not found");

const limitsOf = (row: PrincipalLimit) => ({
  query_concurrency: row.queryConcurrency,
  export_concurrency: row.exportConcurrency,
});

/** The audit metadata of a row as it stands (or stood, for a removal). */
const auditMetadata = (row: PrincipalLimit) => ({
  principal_type: row.principalType,
  principal_id: row.principalId,
  ...limitsOf(row),
});

export const createPrincipalLimit = async (
  input: CreatePrincipalLimitInput,
  actorId: string
): Promise<PrincipalLimit> =>
  withAudit(async (tx, audit) => {
    const taken = await tx.principalLimit.findUnique({
      where: {
        principalType_principalId: {
          principalType: input.principalType,
          principalId: input.principalId,
        },
      },
      select: { id: true },
    });
    if (taken) throw limitsExist();
    const created = await mapUniqueViolation(
      () =>
        tx.principalLimit.create({
          data: {
            principalType: input.principalType,
            principalId: input.principalId,
            queryConcurrency: input.queryConcurrency ?? null,
            exportConcurrency: input.exportConcurrency ?? null,
            createdBy: actorId,
          },
        }),
      limitsExist().message,
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.principalLimitCreated,
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      actorId,
      metadata: auditMetadata(created),
    });
    return created;
  });

/** Changes the fields given; a change that would leave neither limit set is refused. */
export const updatePrincipalLimit = async (
  id: string,
  input: UpdatePrincipalLimitInput,
  actorId: string
): Promise<PrincipalLimit> =>
  withAudit(async (tx, audit) => {
    // Concurrent changes take turns, so each checks the row it changes.
    await tx.$queryRaw`SELECT "id" FROM "zeteo"."principal_limits" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const before = await tx.principalLimit.findUnique({ where: { id } });
    if (!before) throw notFound();
    const queryConcurrency =
      input.queryConcurrency === undefined
        ? before.queryConcurrency
        : input.queryConcurrency;
    const exportConcurrency =
      input.exportConcurrency === undefined
        ? before.exportConcurrency
        : input.exportConcurrency;
    if (queryConcurrency === null && exportConcurrency === null) {
      const message =
        "A change may not clear both limits; remove the principal's limits instead";
      throw new ValidationError(message, [{ path: "", message }]);
    }
    const updated = await tx.principalLimit.update({
      where: { id },
      data: { queryConcurrency, exportConcurrency },
    });
    audit({
      action: AUDIT_EVENTS.principalLimitUpdated,
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      actorId,
      metadata: { ...auditMetadata(updated), previous: limitsOf(before) },
    });
    return updated;
  });

export const removePrincipalLimit = async (
  id: string,
  actorId: string
): Promise<void> => {
  await withAudit(async (tx, audit) => {
    const row = await tx.principalLimit.findUnique({ where: { id } });
    if (!row) throw notFound();
    // A concurrent removal may have deleted it since it was read.
    const { count } = await tx.principalLimit.deleteMany({ where: { id } });
    if (count === 0) throw notFound();
    audit({
      action: AUDIT_EVENTS.principalLimitRemoved,
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      actorId,
      metadata: auditMetadata(row),
    });
  });
};

export const getPrincipalLimit = async (
  id: string
): Promise<PrincipalLimit> => {
  const row = await db.principalLimits.findById(id);
  if (!row) throw notFound();
  return row;
};
