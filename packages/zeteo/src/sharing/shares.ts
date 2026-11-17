import { BadRequestError, ConflictError } from "../utils/errors.js";
import { mapConcurrently } from "../utils/concurrency.js";
import type { SharePrincipal } from "./principals.js";
import type { Caller } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import {
  GROUP_READS_IN_FLIGHT,
  groupOrganizationOf,
  isServiceAccountUser,
  lookupPrincipals,
} from "../principals/directory.js";

// What saved queries, saved panels and dashboards share in how they are shared
// with users and groups and handed to another owner. `noun` is how a message
// names the thing: "saved query", "dashboard".

export type { SharePrincipal } from "./principals.js";

/** A share as `GET` and `PUT .../shares` list it; `email` for users only. */
export interface ShareView {
  type: "user" | "group";
  id: string;
  name: string | null;
  email?: string | null;
  shared_at: string;
}

export const SHARE_OTHER_ORGANIZATION =
  "Groups can only be shared with in your signed-in organization";

/** The 400 for the owner among the recipients. */
export const ownerShareError = (noun: string) =>
  new BadRequestError(
    "invalid_share",
    `A ${noun} cannot be shared with its owner`
  );

/** Whether the owner is among `principals`. */
export const includesOwner = (
  principals: readonly SharePrincipal[],
  ownerId: string
): boolean => principals.some((p) => p.type === "user" && p.id === ownerId);

/** The ids of the principals of `type` among `existing`. */
export const idsOfType = (
  existing: ReadonlyArray<{ principalType: string; principalId: string }>,
  type: "user" | "group"
): Set<string> =>
  new Set(
    existing.filter((s) => s.principalType === type).map((s) => s.principalId)
  );

/**
 * The groups of `principals` not already in `groupsBefore`, each checked to be
 * global or of the caller's signed-in organization (the 400 `invalid_share`
 * otherwise, also for a group the directory does not have). Asks tereo: never
 * inside a transaction. A share carried over unchanged is not checked again.
 */
export const checkNewGroups = async (
  caller: Caller,
  principals: readonly SharePrincipal[],
  groupsBefore: ReadonlySet<string>
): Promise<string[]> => {
  const newGroups = principals
    .filter((p) => p.type === "group" && !groupsBefore.has(p.id))
    .map((p) => p.id);
  const organizations = await mapConcurrently(
    newGroups,
    GROUP_READS_IN_FLIGHT,
    groupOrganizationOf
  );
  if (
    organizations.some(
      (org) =>
        org === undefined || (org !== null && org !== caller.organizationId)
    )
  ) {
    throw new BadRequestError("invalid_share", SHARE_OTHER_ORGANIZATION);
  }
  return newGroups;
};

/**
 * After the write, whether it added a group that `checkNewGroups` did not see
 * (another change removed it meanwhile, so it would be added unchecked): the
 * 409 to retry.
 */
export const assertGroupsChecked = (
  added: readonly SharePrincipal[],
  checked: readonly string[]
): void => {
  if (added.some((p) => p.type === "group" && !checked.includes(p.id))) {
    throw new ConflictError(
      "The shares changed while saving; load them again and retry"
    );
  }
};

/** The shares with the directory's names; a name it cannot give, or a failed lookup, is null. */
export const shareViews = async (
  shares: ReadonlyArray<{
    principalType: "user" | "group";
    principalId: string;
    createdAt: Date;
  }>
): Promise<ShareView[]> => {
  const refs = shares.map((s) => ({
    type: s.principalType,
    id: s.principalId,
  }));
  const found = new Map<
    string,
    { name: string | null; email: string | null }
  >();
  try {
    for (let i = 0; i < refs.length; i += 100) {
      for (const p of await lookupPrincipals(refs.slice(i, i + 100))) {
        found.set(`${p.type}:${p.id}`, {
          name: p.name,
          email: p.email ?? null,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "Could not look up the principals of shares");
  }
  return shares.map((s) => {
    const p = found.get(`${s.principalType}:${s.principalId}`);
    return {
      type: s.principalType,
      id: s.principalId,
      name: p?.name ?? null,
      ...(s.principalType === "user" && { email: p?.email ?? null }),
      shared_at: s.createdAt.toISOString(),
    };
  });
};

/** The owners' names from the directory; a name it cannot give, or a failed lookup, is null. */
export const ownerNames = async (
  ownerIds: string[]
): Promise<Map<string, string | null>> => {
  const names = new Map<string, string | null>(
    ownerIds.map((id) => [id, null])
  );
  if (ownerIds.length === 0) return names;
  try {
    const found = await lookupPrincipals(
      ownerIds.map((id) => ({ type: "user" as const, id }))
    );
    for (const p of found) {
      if (p.status !== "orphaned") names.set(p.id, p.name);
    }
  } catch (err) {
    logger.warn({ err }, "Could not look up the names of owners");
  }
  return names;
};

/** The 400 for handing something to the user who owns it already. */
export const alreadyOwnerError = (noun: string) =>
  new BadRequestError("invalid_transfer", `The user already owns this ${noun}`);

/**
 * That `userId` may be handed a `noun`: a user the directory has, not
 * orphaned, and not a service account (the 400 `invalid_transfer`
 * otherwise). Asks tereo: never inside a transaction.
 */
export const checkTransferTarget = async (
  userId: string,
  noun: string
): Promise<void> => {
  const [target] = await lookupPrincipals([{ type: "user", id: userId }]);
  if (!target || target.status === "orphaned") {
    throw new BadRequestError("invalid_transfer", "No such user");
  }
  if (await isServiceAccountUser(userId)) {
    throw new BadRequestError(
      "invalid_transfer",
      `A ${noun} cannot be transferred to a service account`
    );
  }
};

/** The message of the 409 when the new owner has a `noun` of that name. */
export const transferNameTaken = (noun: string) =>
  `The new owner already has a ${noun} with this name; names are unique whatever their case`;
