import { savedQueryView, type SavedQueryView } from "../views/savedQuery.js";
import type { SavedQuery } from "../../prisma/generated/client/index.js";
import { loadCatalogFor, sourceSlugOf } from "../engine/index.js";
import type { SavedQueryRow } from "../utils/db/savedQueries.js";
import { db, prisma, type Prisma } from "../utils/db/index.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { planFor, type Progress } from "../engine/plan.js";
import { mapConcurrently } from "../utils/concurrency.js";
import { hasPermission } from "../utils/permissions.js";
import { groupIdsOf } from "../grants/principals.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import { planSaved } from "../engine/savedPlan.js";
import { encodeCursor } from "../utils/cursor.js";
import { logger } from "../utils/logger.js";
import { decideAccess } from "./access.js";
import {
  AUDIT_EVENTS,
  SAVED_QUERIES_READ,
  SAVED_QUERIES_WRITE,
  SOURCES_READ,
} from "../definitions/tereoDeclaration.js";
import {
  GROUP_READS_IN_FLIGHT,
  groupOrganizationOf,
  isServiceAccountUser,
  lookupPrincipals,
} from "../principals/directory.js";
import {
  loadAccess,
  loadAccessAs,
  type CallerAccess,
} from "../grants/access.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/errors.js";

const notFound = () => new NotFoundError("Saved query not found");

const nameTaken = () =>
  "You already have a saved query with this name; names are unique whatever their case";

const freshProgress = (): Progress => ({ sourceId: null, unrecorded: false });

/** The audit metadata every entry carries: the names and ids, never the query. */
const auditMetadata = (row: SavedQuery) => ({
  name: row.name,
  source_id: row.sourceId,
  owner_id: row.ownerId,
});

/**
 * Whether the caller may manage the saved query's shares or owner with
 * `permission`: they own it, or hold it. With `zeteo.saved_queries.read`, it
 * is whether they may see the share list.
 */
const mayManage = (
  caller: Caller,
  row: SavedQuery,
  permission: typeof SAVED_QUERIES_READ | typeof SAVED_QUERIES_WRITE
): boolean =>
  row.ownerId === caller.userId ||
  hasPermission(caller.permissions, permission);

/** Locks the saved query's row until the transaction ends. */
const lockRow = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT "id" FROM "zeteo"."saved_queries" WHERE "id" = ${id}::uuid FOR UPDATE`;

/** The owners' names from the directory; a name it cannot give, or a failed lookup, is null. */
const ownerNames = async (
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
    logger.warn({ err }, "Could not look up the owners of saved queries");
  }
  return names;
};

/**
 * `rows` as views for the caller: whether each can be run by them (planned as
 * them, so no cause is told apart), the owners' names, and the source slug
 * where the view may show it. Not to be called inside a transaction: it asks
 * tereo.
 */
const present = async (
  caller: Caller,
  access: CallerAccess,
  rows: SavedQueryRow[]
): Promise<SavedQueryView[]> => {
  const decided = await decideAccess(access, rows);
  const showSource = hasPermission(caller.permissions, SOURCES_READ);
  const wanted = rows.filter((r) => decided.get(r.id) || showSource);
  const slugs = new Map(
    (
      await prisma.source.findMany({
        where: { id: { in: [...new Set(wanted.map((r) => r.sourceId))] } },
        select: { id: true, slug: true },
      })
    ).map((s) => [s.id, s.slug])
  );
  const names = await ownerNames([...new Set(rows.map((r) => r.ownerId))]);
  const counts = await db.savedQueries.countShares(
    rows
      .filter((r) => mayManage(caller, r, SAVED_QUERIES_READ))
      .map((r) => r.id)
  );
  return rows.map((row) =>
    savedQueryView(row, {
      accessible: decided.get(row.id) ?? false,
      ownerName: names.get(row.ownerId) ?? null,
      sourceSlug: slugs.get(row.sourceId) ?? null,
      showSource,
      shareCount: counts.get(row.id),
    })
  );
};

const presentOne = async (
  caller: Caller,
  access: CallerAccess,
  row: SavedQuery
): Promise<SavedQueryView> => {
  const [withViewer] = await db.savedQueries.withViewer(
    [row],
    caller.userId,
    access.groupIds
  );
  return (await present(caller, access, [withViewer!]))[0]!;
};

/**
 * The saved query, when the caller may see it that it exists at all: they own
 * it, it is shared with them or one of their groups, or they hold
 * `zeteo.saved_queries.read`. Anything else is the one 404.
 */
export const findForViewer = async (
  caller: Caller,
  id: string,
  groupIds?: readonly string[]
): Promise<SavedQuery> => {
  const row = await db.savedQueries.findById(id);
  if (!row) throw notFound();
  if (
    row.ownerId === caller.userId ||
    hasPermission(caller.permissions, SAVED_QUERIES_READ)
  ) {
    return row;
  }
  const groups = groupIds ?? (await groupIdsOf(caller));
  if (await db.savedQueries.isSharedWith(id, caller.userId, groups)) return row;
  throw notFound();
};

/** The caller's own saved query, else the 404 (a recipient or an admin has none to change). */
const findOwned = async (caller: Caller, id: string): Promise<SavedQuery> => {
  const row = await db.savedQueries.findById(id);
  if (!row || row.ownerId !== caller.userId) throw notFound();
  return row;
};

export interface ListSavedQueriesInput {
  scope: "mine" | "shared" | "all";
  q?: string;
  sourceId?: string;
  ownerId?: string;
  /** `scope: "all"` only: the saved queries shared directly with this user or group. */
  sharedWith?: { type: "user" | "group"; id: string };
  cursor?: string;
  limit: number;
}

export const listSavedQueries = async (
  caller: Caller,
  input: ListSavedQueriesInput
): Promise<{ data: SavedQueryView[]; nextCursor: string | null }> => {
  if (input.scope === "all") {
    if (!hasPermission(caller.permissions, SAVED_QUERIES_READ)) {
      throw new ForbiddenError(`Requires the ${SAVED_QUERIES_READ} permission`);
    }
    if (input.sourceId && !hasPermission(caller.permissions, SOURCES_READ)) {
      throw new ForbiddenError(`Requires the ${SOURCES_READ} permission`);
    }
  }
  const access = await loadAccess(caller);
  const page =
    input.scope === "all"
      ? await db.savedQueries
          .listAll({
            ownerId: input.ownerId,
            sourceId: input.sourceId,
            sharedWith: input.sharedWith,
            q: input.q,
            cursor: input.cursor,
            limit: input.limit,
          })
          .then(async ({ rows, hasMore }) => ({
            rows: await db.savedQueries.withViewer(
              rows,
              caller.userId,
              access.groupIds
            ),
            hasMore,
          }))
      : await db.savedQueries.listVisibleTo({
          userId: caller.userId,
          groupIds: [...access.groupIds],
          scope: input.scope,
          q: input.q,
          cursor: input.cursor,
          limit: input.limit,
        });
  const last = page.rows.at(-1);
  return {
    data: await present(caller, access, page.rows),
    nextCursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  };
};

export const getSavedQuery = async (
  caller: Caller,
  id: string
): Promise<SavedQueryView> => {
  const access = await loadAccess(caller);
  const row = await findForViewer(caller, id, access.groupIds);
  return presentOne(caller, access, row);
};

export interface CreateSavedQueryInput {
  name: string;
  description: string;
  query: Record<string, unknown>;
}

/**
 * Saves a query for the caller. It is planned against the caller's own
 * grants exactly as `POST /v1/query` plans it, so the same errors, with their
 * detail, come back: it is their own query.
 */
export const createSavedQuery = async (
  caller: Caller,
  input: CreateSavedQueryInput
): Promise<SavedQueryView> => {
  const progress = freshProgress();
  const slug = sourceSlugOf(input.query);
  const { access, catalog } = await loadCatalogFor(caller, slug, progress);
  planFor(input.query, access, catalog, progress);
  const row = await withAudit(async (tx, audit) => {
    const created = await mapUniqueViolation(
      () =>
        db.savedQueries.create(
          {
            ownerId: caller.userId,
            sourceId: catalog.source.id,
            name: input.name,
            description: input.description,
            query: input.query as Prisma.InputJsonObject,
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.savedQueryCreated,
      resourceType: "saved_query",
      resourceId: created.id,
      actorId: caller.userId,
      metadata: auditMetadata(created),
    });
    return created;
  });
  return presentOne(caller, access, row);
};

export interface UpdateSavedQueryInput {
  name?: string;
  description?: string;
  query?: Record<string, unknown>;
}

/**
 * Changes the caller's own saved query. A changed query is planned again
 * against their grants, and the saved query moves to its source. The owner
 * need not be able to run it to rename or describe it.
 */
export const updateSavedQuery = async (
  caller: Caller,
  id: string,
  patch: UpdateSavedQueryInput
): Promise<SavedQueryView> => {
  await findOwned(caller, id);
  let access: CallerAccess;
  let sourceId: string | undefined;
  if (patch.query) {
    const progress = freshProgress();
    const slug = sourceSlugOf(patch.query);
    const loaded = await loadCatalogFor(caller, slug, progress);
    planFor(patch.query, loaded.access, loaded.catalog, progress);
    access = loaded.access;
    sourceId = loaded.catalog.source.id;
  } else {
    access = await loadAccess(caller);
  }
  const row = await withAudit(async (tx, audit) => {
    await lockRow(tx, id);
    const current = await db.savedQueries.findById(id, tx);
    if (!current || current.ownerId !== caller.userId) throw notFound();
    const updated = await mapUniqueViolation(
      () =>
        db.savedQueries.update(
          id,
          {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && {
              description: patch.description,
            }),
            ...(patch.query && {
              query: patch.query as Prisma.InputJsonObject,
              sourceId,
            }),
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.savedQueryUpdated,
      resourceType: "saved_query",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        ...auditMetadata(updated),
        ...(patch.name !== undefined &&
          patch.name !== current.name && { previous_name: current.name }),
        changed: (["name", "description", "query"] as const).filter(
          (field) => patch[field] !== undefined
        ),
      },
    });
    return updated;
  });
  return presentOne(caller, access, row);
};

/** Deletes a saved query: its owner may, and so may a holder of `zeteo.saved_queries.write`. Anyone else is told it does not exist. */
export const deleteSavedQuery = async (
  caller: Caller,
  id: string
): Promise<void> => {
  const found = await db.savedQueries.findById(id);
  if (
    !found ||
    (found.ownerId !== caller.userId &&
      !hasPermission(caller.permissions, SAVED_QUERIES_WRITE))
  ) {
    throw notFound();
  }
  await withAudit(async (tx, audit) => {
    await lockRow(tx, id);
    const current = await db.savedQueries.findById(id, tx);
    if (!current) throw notFound();
    await db.savedQueries.remove(id, tx);
    audit({
      action: AUDIT_EVENTS.savedQueryDeleted,
      resourceType: "saved_query",
      resourceId: id,
      actorId: caller.userId,
      metadata: auditMetadata(current),
    });
  });
};

/**
 * The caller's own copy of a saved query they can see and run. A saved query
 * they cannot run is `SavedQueryNotAccessibleError`, whatever the cause.
 */
export const copySavedQuery = async (
  caller: Caller,
  id: string,
  name: string
): Promise<SavedQueryView> => {
  const access = await loadAccess(caller);
  const source = await findForViewer(caller, id, access.groupIds);
  await planSaved(access, source, freshProgress());
  const row = await withAudit(async (tx, audit) => {
    const created = await mapUniqueViolation(
      () =>
        db.savedQueries.create(
          {
            ownerId: caller.userId,
            sourceId: source.sourceId,
            name,
            description: source.description,
            query: source.query as Prisma.InputJsonValue,
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.savedQueryCopied,
      resourceType: "saved_query",
      resourceId: created.id,
      actorId: caller.userId,
      metadata: { ...auditMetadata(created), copied_from: source.id },
    });
    return created;
  });
  return presentOne(caller, access, row);
};

/** What a run or export of a saved query may change: its paging only. */
export interface SavedQueryPaging {
  limit?: number;
  offset?: number;
}

/** A saved query ready for `runQuery` or `runExport`: its body and what the engine needs of it. */
export interface SavedQueryToRun {
  body: Record<string, unknown>;
  savedQuery: { id: string; sourceId: string };
}

/**
 * The saved query, found as `findForViewer` finds it, as the engine runs it:
 * its stored JSON with `limit` and `offset` replaced by any given. Whether
 * the caller may run it is decided by the engine, as it plans.
 */
export const savedQueryToRun = async (
  caller: Caller,
  id: string,
  paging: SavedQueryPaging
): Promise<SavedQueryToRun> => {
  const row = await findForViewer(caller, id);
  return {
    body: {
      ...(row.query as Record<string, unknown>),
      ...(paging.limit !== undefined && { limit: paging.limit }),
      ...(paging.offset !== undefined && { offset: paging.offset }),
    },
    savedQuery: { id: row.id, sourceId: row.sourceId },
  };
};

/** A user or group a saved query is shared with. */
export interface SharePrincipal {
  type: "user" | "group";
  id: string;
}

/** A share as `GET` and `PUT .../shares` list it; `email` for users only. */
export interface ShareView {
  type: "user" | "group";
  id: string;
  name: string | null;
  email?: string | null;
  shared_at: string;
}

const SHARE_OTHER_ORGANIZATION =
  "Groups can only be shared with in your signed-in organization";

/** How many users' access a share or transfer judges at once; each asks tereo for the user's groups. */
const ACCESS_CHECKS_IN_FLIGHT = 4;

/**
 * The saved query, when the caller may manage it with `permission`. One they
 * may see but not change (`zeteo.saved_queries.read` alone, for a change) is
 * a 403; anyone else, a recipient included, gets the one 404.
 */
const findManaged = async (
  caller: Caller,
  id: string,
  permission: typeof SAVED_QUERIES_READ | typeof SAVED_QUERIES_WRITE
): Promise<SavedQuery> => {
  const row = await db.savedQueries.findById(id);
  if (!row) throw notFound();
  if (mayManage(caller, row, permission)) return row;
  if (hasPermission(caller.permissions, SAVED_QUERIES_READ)) {
    throw new ForbiddenError(`Requires the ${permission} permission`);
  }
  throw notFound();
};

/** Locks the saved query and reads it again: the 404 if it is gone, or if the caller may no longer manage it. */
const lockManaged = async (
  tx: Prisma.TransactionClient,
  caller: Caller,
  id: string
): Promise<SavedQuery> => {
  await lockRow(tx, id);
  const current = await db.savedQueries.findById(id, tx);
  if (!current || !mayManage(caller, current, SAVED_QUERIES_WRITE)) {
    throw notFound();
  }
  return current;
};

/** The shares with the directory's names; a name it cannot give, or a failed lookup, is null. */
const shareViews = async (id: string): Promise<ShareView[]> => {
  const shares = await db.savedQueries.listShares(id);
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

/** Whether `userId` could run the saved query, judged as if signed in to `organizationId`. Asks tereo: never inside a transaction. */
const canRunAs = async (
  row: SavedQuery,
  userId: string,
  organizationId: string | null
): Promise<boolean> =>
  (await decideAccess(await loadAccessAs(userId, organizationId), [row])).get(
    row.id
  ) ?? false;

/** Of `userIds`, those who could not run the saved query. */
const unableToRun = async (
  row: SavedQuery,
  userIds: string[],
  organizationId: string | null
): Promise<Set<string>> => {
  const able = await mapConcurrently(userIds, ACCESS_CHECKS_IN_FLIGHT, (u) =>
    canRunAs(row, u, organizationId)
  );
  return new Set(userIds.filter((_, i) => !able[i]));
};

/** The saved query's shares: for its owner, or a holder of `zeteo.saved_queries.read`. */
export const listShares = async (
  caller: Caller,
  id: string
): Promise<ShareView[]> => {
  const row = await findManaged(caller, id, SAVED_QUERIES_READ);
  return shareViews(row.id);
};

/**
 * Makes the saved query's shares exactly `principals`: for its owner, or a
 * holder of `zeteo.saved_queries.write`. Every group being added must be global
 * or of the caller's signed-in organization; one already shared is not
 * checked again. Each user newly added who could not run it,
 * judged as if signed in to that organization, is in `warnings`; groups never
 * are. Replacements of one saved query's shares run one at a time.
 */
export const replaceShares = async (
  caller: Caller,
  id: string,
  principals: SharePrincipal[]
): Promise<{
  data: ShareView[];
  warnings: Array<{ type: "user"; id: string; accessible: false }>;
}> => {
  const found = await findManaged(caller, id, SAVED_QUERIES_WRITE);
  const ownerShare = () =>
    new BadRequestError(
      "invalid_share",
      "A saved query cannot be shared with its owner"
    );
  const isOwner = (owner: string) =>
    principals.some((p) => p.type === "user" && p.id === owner);
  if (isOwner(found.ownerId)) throw ownerShare();

  const existing = await db.savedQueries.listShares(id);
  const had = (type: "user" | "group") =>
    new Set(
      existing.filter((s) => s.principalType === type).map((s) => s.principalId)
    );
  const [usersBefore, groupsBefore] = [had("user"), had("group")];
  // Tereo is asked here, before the transaction. Only groups being added are
  // checked: a share carried over unchanged stands as it was made.
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
  const newUsers = principals
    .filter((p) => p.type === "user" && !usersBefore.has(p.id))
    .map((p) => p.id);
  const unable = await unableToRun(found, newUsers, caller.organizationId);

  const { row, added } = await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (isOwner(current.ownerId)) throw ownerShare();
    const changes = await db.savedQueries.replaceShares(
      tx,
      id,
      principals,
      caller.userId
    );
    // A group removed by someone else meanwhile would be added here unchecked.
    if (
      changes.added.some((p) => p.type === "group" && !newGroups.includes(p.id))
    ) {
      throw new ConflictError(
        "The shares changed while saving; load them again and retry"
      );
    }
    if (changes.added.length > 0 || changes.removed.length > 0) {
      audit({
        action: AUDIT_EVENTS.savedQueryShared,
        resourceType: "saved_query",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          ...auditMetadata(current),
          added: changes.added,
          removed: changes.removed,
        },
      });
    }
    return { row: current, added: changes.added };
  });

  const addedUsers = added.filter((p) => p.type === "user").map((p) => p.id);
  // A user added meanwhile by someone else's change was not judged above.
  const unjudged = addedUsers.filter((u) => !newUsers.includes(u));
  for (const u of await unableToRun(row, unjudged, caller.organizationId)) {
    unable.add(u);
  }
  return {
    data: await shareViews(id),
    warnings: addedUsers
      .filter((u) => unable.has(u))
      .map((u) => ({
        type: "user" as const,
        id: u,
        accessible: false as const,
      })),
  };
};

/**
 * Makes `userId` the saved query's owner: for its owner, or a holder of
 * `zeteo.saved_queries.write`. A service account cannot own one handed over,
 * and the new owner must not already have one of that name. With
 * `keepAccess`, the previous owner keeps a direct share. `warning` says the
 * new owner could not run it, judged as if signed in to the caller's
 * organization.
 */
export const transferSavedQuery = async (
  caller: Caller,
  id: string,
  { userId, keepAccess }: { userId: string; keepAccess: boolean }
): Promise<{ data: SavedQueryView; warning?: { accessible: false } }> => {
  const found = await findManaged(caller, id, SAVED_QUERIES_WRITE);
  const alreadyOwner = () =>
    new BadRequestError(
      "invalid_transfer",
      "The user already owns this saved query"
    );
  if (found.ownerId === userId) throw alreadyOwner();
  // Tereo is asked here, before the transaction.
  const [target] = await lookupPrincipals([{ type: "user", id: userId }]);
  if (!target || target.status === "orphaned") {
    throw new BadRequestError("invalid_transfer", "No such user");
  }
  if (await isServiceAccountUser(userId)) {
    throw new BadRequestError(
      "invalid_transfer",
      "A saved query cannot be transferred to a service account"
    );
  }
  const accessible = await canRunAs(found, userId, caller.organizationId);
  const access = await loadAccess(caller);

  const row = await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (current.ownerId === userId) throw alreadyOwner();
    const updated = await mapUniqueViolation(
      () =>
        db.savedQueries.transfer(
          tx,
          id,
          userId,
          keepAccess ? current.ownerId : null
        ),
      "The new owner already has a saved query with this name; names are unique whatever their case",
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.savedQueryTransferred,
      resourceType: "saved_query",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        ...auditMetadata(updated),
        from: current.ownerId,
        to: userId,
        keep_access: keepAccess,
      },
    });
    return updated;
  });
  return {
    data: await presentOne(caller, access, row),
    ...(!accessible && { warning: { accessible: false as const } }),
  };
};
