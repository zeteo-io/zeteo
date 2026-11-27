import { savedQueryView, type SavedQueryView } from "../views/savedQuery.js";
import type { SavedQuery } from "../../prisma/generated/client/index.js";
import { loadSourceVisibleCatalog } from "../grants/visibleCatalog.js";
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
import { canUse, decideAccess } from "./access.js";
import { encodeCursor } from "../utils/cursor.js";
import {
  AUDIT_EVENTS,
  SAVED_QUERIES_READ,
  SAVED_QUERIES_WRITE,
  SOURCES_READ,
} from "../definitions/tereoDeclaration.js";
import {
  alreadyOwnerError,
  assertGroupsChecked,
  checkNewGroups,
  checkTransferTarget,
  idsOfType,
  includesOwner,
  ownerNames,
  ownerShareError,
  shareViews,
  transferNameTaken,
  type ShareView,
  type SharePrincipal,
} from "../sharing/shares.js";
import {
  loadAccess,
  loadAccessAs,
  type CallerAccess,
} from "../grants/access.js";
import {
  ForbiddenError,
  NotFoundError,
  SavedQueryNotAccessibleError,
} from "../utils/errors.js";

const NOUN = "saved query";

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

/**
 * `rows` as views for the caller: whether each can be run by them (planned as
 * them, so no cause is told apart), the owners' names, and the source slug
 * where the view may show it. Not to be called inside a transaction: it asks
 * tereo.
 */
const present = async (
  caller: Caller,
  access: CallerAccess,
  rows: SavedQueryRow[],
  withUsedBy = false
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
  const usedBy = new Map<string, { dashboards: number; savedPanels: number }>();
  if (withUsedBy) {
    for (const r of rows.filter((r) =>
      mayManage(caller, r, SAVED_QUERIES_READ)
    )) {
      usedBy.set(r.id, {
        dashboards: await db.dashboards.countUsingSavedQuery(r.id),
        savedPanels: await db.savedPanels.countUsingSavedQuery(r.id),
      });
    }
  }
  return rows.map((row) =>
    savedQueryView(row, {
      usedBy: usedBy.get(row.id),
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
  return (await present(caller, access, [withViewer!], true))[0]!;
};

/**
 * The saved query, when the caller may see it that it exists at all: they own
 * it, it is shared with them or one of their groups, it is available for
 * dashboards in the organization they are signed in to (null matches null), or
 * they hold `zeteo.saved_queries.read`. Anything else is the one 404.
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
  if (
    row.availableForDashboards &&
    row.availableOrganizationId === caller.organizationId
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
  scope: "mine" | "shared" | "all" | "available";
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
      : input.scope === "available"
        ? await db.savedQueries
            .listAvailable({
              organizationId: caller.organizationId,
              excludeOwnerId: caller.userId,
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
  availableForDashboards?: boolean;
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
            ...(patch.availableForDashboards !== undefined && {
              availableForDashboards: patch.availableForDashboards,
              availableOrganizationId: patch.availableForDashboards
                ? caller.organizationId
                : null,
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
        ...(patch.availableForDashboards !== undefined && {
          available_for_dashboards: updated.availableForDashboards,
          available_organization_id: updated.availableOrganizationId,
        }),
        changed: [
          ...(["name", "description", "query"] as const).filter(
            (field) => patch[field] !== undefined
          ),
          ...(patch.availableForDashboards !== undefined
            ? ["available_for_dashboards"]
            : []),
        ],
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
  // Copying needs access to the query, not to its rows: no row rule applies.
  if (
    !canUse(
      access,
      source,
      await loadSourceVisibleCatalog(source.sourceId, access)
    )
  ) {
    throw new SavedQueryNotAccessibleError();
  }
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

const shareViewsOf = async (id: string): Promise<ShareView[]> =>
  shareViews(await db.savedQueries.listShares(id));

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
  return shareViewsOf(row.id);
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
  if (includesOwner(principals, found.ownerId)) {
    throw ownerShareError(NOUN);
  }

  const existing = await db.savedQueries.listShares(id);
  const usersBefore = idsOfType(existing, "user");
  // Tereo is asked here, before the transaction. Only groups being added are
  // checked: a share carried over unchanged stands as it was made.
  const newGroups = await checkNewGroups(
    caller,
    principals,
    idsOfType(existing, "group")
  );
  const newUsers = principals
    .filter((p) => p.type === "user" && !usersBefore.has(p.id))
    .map((p) => p.id);
  const unable = await unableToRun(found, newUsers, caller.organizationId);

  const { row, added } = await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (includesOwner(principals, current.ownerId)) {
      throw ownerShareError(NOUN);
    }
    const changes = await db.savedQueries.replaceShares(
      tx,
      id,
      principals,
      caller.userId
    );
    // A group removed by someone else meanwhile would be added here unchecked.
    assertGroupsChecked(changes.added, newGroups);
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
    data: await shareViewsOf(id),
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
  if (found.ownerId === userId) throw alreadyOwnerError(NOUN);
  // Tereo is asked here, before the transaction.
  await checkTransferTarget(userId, NOUN);
  const accessible = await canRunAs(found, userId, caller.organizationId);
  const access = await loadAccess(caller);

  const row = await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (current.ownerId === userId) throw alreadyOwnerError(NOUN);
    const updated = await mapUniqueViolation(
      () =>
        db.savedQueries.transfer(
          tx,
          id,
          userId,
          keepAccess ? current.ownerId : null
        ),
      transferNameTaken(NOUN),
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

export type SavedQueryUse = {
  type: "dashboard" | "saved_panel";
  id: string;
  name: string;
  owner: { id: string; name: string | null };
};

/**
 * The dashboards and saved panels built on the saved query, for an admin who
 * may read dashboards (the route checks the permission). Not to be called
 * inside a transaction: it asks tereo for the owners' names.
 */
export const listUses = async (id: string): Promise<SavedQueryUse[]> => {
  if (!(await db.savedQueries.findById(id))) throw notFound();
  const [dashboards, panels] = await Promise.all([
    db.dashboards.listUsingSavedQuery(id),
    db.savedPanels.listUsingSavedQuery(id),
  ]);
  const names = await ownerNames([
    ...new Set([...dashboards, ...panels].map((r) => r.ownerId)),
  ]);
  const owner = (ownerId: string) => ({
    id: ownerId,
    name: names.get(ownerId) ?? null,
  });
  return [
    ...dashboards.map((d) => ({
      type: "dashboard" as const,
      id: d.id,
      name: d.name,
      owner: owner(d.ownerId),
    })),
    ...panels.map((p) => ({
      type: "saved_panel" as const,
      id: p.id,
      name: p.name,
      owner: owner(p.ownerId),
    })),
  ];
};

export type { ShareView, SharePrincipal };
