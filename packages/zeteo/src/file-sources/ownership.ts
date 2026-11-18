import type { Source } from "../../prisma/generated/client/index.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import { hasPermission } from "../utils/permissions.js";
import type { Caller } from "../middleware/auth.js";
import { ForbiddenError } from "../utils/errors.js";
import { isFileSource } from "../sources/types.js";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../definitions/tereoDeclaration.js";

// What a file source's owner may do on their own source's tables without an
// admin's permission: grants, declared relations and descriptions. An owner
// who lost `zeteo.file_sources.write` (or `zeteo.data.read`) may not.

/** The 403 a caller without `permission` gets today; an owner refused gets exactly this. */
export const lacking = (permission: string) =>
  new ForbiddenError(`Requires the ${permission} permission`);

/** Whether the caller holds what an owner needs to manage: `zeteo.file_sources.write` and `zeteo.data.read`. */
export const mayActAsOwner = (caller: Caller): boolean =>
  hasPermission(caller.permissions, FILE_SOURCES_WRITE) &&
  hasPermission(caller.permissions, DATA_READ);

/** Whether the caller manages `row` as its owner: a file source of theirs, and `mayActAsOwner`. */
export const ownsFileSource = (
  caller: Caller,
  row: Pick<Source, "type" | "ownerId">
): boolean =>
  isFileSource(row) && row.ownerId === caller.userId && mayActAsOwner(caller);

/** Whether the source of `sourceId` is a file source the caller manages as its owner. */
export const ownsFileSourceOf = async (
  caller: Caller,
  sourceId: string
): Promise<boolean> => {
  const row = await prisma.source.findUnique({
    where: { id: sourceId },
    select: { type: true, ownerId: true },
  });
  return row !== null && ownsFileSource(caller, row);
};

/**
 * In `tx`, holds the source's row against a transfer (`FOR SHARE`) and checks
 * the caller still owns it: the `lacking(permission)` 403 otherwise.
 */
export const assertOwnsInTx = async (
  tx: Prisma.TransactionClient,
  caller: Caller,
  sourceId: string,
  permission: string
): Promise<void> => {
  await tx.$queryRaw`SELECT "id" FROM "zeteo"."sources" WHERE "id" = ${sourceId}::uuid FOR SHARE`;
  const row = await tx.source.findUnique({
    where: { id: sourceId },
    select: { type: true, ownerId: true },
  });
  if (!row || !ownsFileSource(caller, row)) throw lacking(permission);
};

/**
 * The principals (`type:id`) holding a grant on a table of a file source
 * `userId` owns: whom an owner may name through the principals lookup.
 */
export const grantPrincipalsOfOwnedSources = async (
  userId: string
): Promise<Set<string>> => {
  const grants = await prisma.grant.findMany({
    where: { table: { source: { type: "upload", ownerId: userId } } },
    select: { principalType: true, principalId: true },
    distinct: ["principalType", "principalId"],
  });
  return new Set(grants.map((g) => `${g.principalType}:${g.principalId}`));
};
