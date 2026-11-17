import { withTimeFilter, type TimeRangeKey } from "../dashboards/timeRange.js";
import { savedPanelView, type SavedPanelView } from "../views/savedPanel.js";
import type { SavedPanel } from "../../prisma/generated/client/index.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import type { ChartSettings } from "../dashboards/chart.js";
import { mapConcurrently } from "../utils/concurrency.js";
import { checkOwnPanel } from "../dashboards/service.js";
import { hasPermission } from "../utils/permissions.js";
import { db, type Prisma } from "../utils/db/index.js";
import { groupIdsOf } from "../grants/principals.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import { encodeCursor } from "../utils/cursor.js";
import { loadAccess } from "../grants/access.js";
import {
  AUDIT_EVENTS,
  DASHBOARDS_READ,
  DASHBOARDS_WRITE,
} from "../definitions/tereoDeclaration.js";
import {
  decideNewPanel,
  decideSavedPanel,
  type PanelDecision,
} from "../dashboards/decide.js";
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
  BadRequestError,
  ForbiddenError,
  InvalidPanelError,
  NotFoundError,
  SavedQueryNotAccessibleError,
} from "../utils/errors.js";

const NOUN = "saved panel";

const notFound = () => new NotFoundError("Saved panel not found");

const nameTaken = () =>
  "You already have a saved panel with this name; names are unique whatever their case";

/** The audit metadata every entry carries: the names and ids, never a chart. */
const auditMetadata = (row: SavedPanel) => ({
  name: row.name,
  owner_id: row.ownerId,
});

type ManagePermission = typeof DASHBOARDS_READ | typeof DASHBOARDS_WRITE;

/** Whether the caller may manage the saved panel's shares or owner with `permission`: they own it, or hold it. */
const mayManage = (
  caller: Caller,
  row: SavedPanel,
  permission: ManagePermission
): boolean =>
  row.ownerId === caller.userId ||
  hasPermission(caller.permissions, permission);

/** Locks the saved panel's row until the transaction ends. */
const lockRow = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT "id" FROM "zeteo"."saved_panels" WHERE "id" = ${id}::uuid FOR UPDATE`;

const asJson = (chart: ChartSettings) =>
  chart as unknown as Prisma.InputJsonObject;

// --- Reading -------------------------------------------------------------

/**
 * The saved panel, when the caller may see that it exists at all: they own
 * it, it is shared with them or one of their groups, or they hold
 * `zeteo.dashboards.read`. Anything else is the one 404.
 */
export const findSavedPanelForViewer = async (
  caller: Caller,
  id: string,
  groupIds?: readonly string[]
): Promise<SavedPanel> => {
  const row = await db.savedPanels.findById(id);
  if (!row) throw notFound();
  if (
    row.ownerId === caller.userId ||
    hasPermission(caller.permissions, DASHBOARDS_READ)
  ) {
    return row;
  }
  const groups = groupIds ?? (await groupIdsOf(caller));
  if (
    (await db.savedPanels.sharedWithAmong([id], caller.userId, groups)).has(id)
  ) {
    return row;
  }
  throw notFound();
};

/** The caller's own saved panel, else the 404 (a recipient or an admin has none to change). */
const findOwned = async (caller: Caller, id: string): Promise<SavedPanel> => {
  const row = await db.savedPanels.findById(id);
  if (!row || row.ownerId !== caller.userId) throw notFound();
  return row;
};

/** `rows` as the caller sees them, each decided for them. Not inside a transaction: it asks tereo. */
const present = async (
  caller: Caller,
  rows: SavedPanel[]
): Promise<SavedPanelView[]> => {
  const groupIds = await groupIdsOf(caller);
  const decisions = await mapConcurrently(rows, 4, (r) =>
    decideSavedPanel(caller, r)
  );
  const mayList = rows.filter((r) => mayManage(caller, r, DASHBOARDS_READ));
  const [names, counts, shared, used] = await Promise.all([
    ownerNames([...new Set(rows.map((r) => r.ownerId))]),
    db.savedPanels.countShares(mayList.map((r) => r.id)),
    db.savedPanels.sharedAtFor(
      rows.map((r) => r.id),
      caller.userId,
      groupIds
    ),
    Promise.all(
      mayList.map(
        async (r) =>
          [r.id, await db.dashboards.countUsingSavedPanel(r.id)] as const
      )
    ),
  ]);
  const usedBy = new Map(used);
  return rows.map((row, i) =>
    savedPanelView(row, decisions[i]!, {
      ownerName: names.get(row.ownerId) ?? null,
      sharedAt: shared.get(row.id) ?? null,
      ...(counts.has(row.id) &&
        mayList.includes(row) && { shareCount: counts.get(row.id) }),
      ...(usedBy.has(row.id) && { usedByDashboards: usedBy.get(row.id) }),
    })
  );
};

const presentOne = async (
  caller: Caller,
  row: SavedPanel
): Promise<SavedPanelView> => (await present(caller, [row]))[0]!;

export interface ListSavedPanelsInput {
  scope: "mine" | "shared" | "all";
  q?: string;
  /** `scope: "all"` only. */
  ownerId?: string;
  cursor?: string;
  limit: number;
}

export const listSavedPanels = async (
  caller: Caller,
  input: ListSavedPanelsInput
) => {
  if (
    input.scope === "all" &&
    !hasPermission(caller.permissions, DASHBOARDS_READ)
  ) {
    throw new ForbiddenError(`Requires the ${DASHBOARDS_READ} permission`);
  }
  const page =
    input.scope === "all"
      ? await db.savedPanels.listAll({
          ownerId: input.ownerId,
          q: input.q,
          cursor: input.cursor,
          limit: input.limit,
        })
      : await db.savedPanels.listVisibleTo({
          userId: caller.userId,
          groupIds: [...(await groupIdsOf(caller))],
          scope: input.scope,
          q: input.q,
          cursor: input.cursor,
          limit: input.limit,
        });
  const last = page.rows.at(-1);
  return {
    data: await present(caller, page.rows),
    nextCursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  };
};

export const getSavedPanel = async (caller: Caller, id: string) =>
  presentOne(caller, await findSavedPanelForViewer(caller, id));

// --- Writing -------------------------------------------------------------

export interface CreateSavedPanelInput {
  name: string;
  description: string;
  savedQueryId: string;
  chart: ChartSettings;
  timeColumn?: string;
}

const insert = async (
  caller: Caller,
  data: {
    name: string;
    description: string;
    savedQueryId: string;
    chart: ChartSettings;
    timeColumn: string | null;
  },
  event:
    | typeof AUDIT_EVENTS.savedPanelCreated
    | typeof AUDIT_EVENTS.savedPanelCopied,
  extra: Record<string, unknown> = {}
): Promise<SavedPanel> =>
  withAudit(async (tx, audit) => {
    const created = await mapUniqueViolation(
      () =>
        db.savedPanels.create(
          {
            ownerId: caller.userId,
            name: data.name,
            description: data.description,
            savedQueryId: data.savedQueryId,
            chart: asJson(data.chart),
            timeColumn: data.timeColumn,
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    audit({
      action: event,
      resourceType: "saved_panel",
      resourceId: created.id,
      actorId: caller.userId,
      metadata: { ...auditMetadata(created), ...extra },
    });
    return created;
  });

/** Creates a saved panel for the caller, checked as an own panel of theirs is: it is their own, so what is wrong is told. */
export const createSavedPanel = async (
  caller: Caller,
  input: CreateSavedPanelInput
): Promise<SavedPanelView> => {
  await checkOwnPanel(caller, await loadAccess(caller), null, {
    savedQueryId: input.savedQueryId,
    chart: input.chart,
    timeColumn: input.timeColumn ?? null,
  });
  const row = await insert(
    caller,
    { ...input, timeColumn: input.timeColumn ?? null },
    AUDIT_EVENTS.savedPanelCreated
  );
  return presentOne(caller, row);
};

/**
 * Saves an own panel of the caller's dashboard as a saved panel of theirs,
 * with the panel's saved query, chart and time column. A linked panel already
 * is one.
 */
export const saveFromPanel = async (
  caller: Caller,
  dashboardId: string,
  panelId: string,
  input: { name: string; description?: string }
): Promise<SavedPanelView> => {
  const dashboard = await db.dashboards.findWithPanels(dashboardId);
  if (!dashboard || dashboard.ownerId !== caller.userId) {
    throw new NotFoundError("Dashboard not found");
  }
  const panel = dashboard.panels.find((p) => p.id === panelId);
  if (!panel) throw new NotFoundError("Panel not found");
  if (panel.kind !== "own") {
    throw new BadRequestError(
      "invalid_panel",
      "A linked panel is already a saved panel"
    );
  }
  const timeRange = dashboard.timeRange as Parameters<typeof checkOwnPanel>[2];
  await checkOwnPanel(caller, await loadAccess(caller), timeRange, {
    savedQueryId: panel.savedQueryId,
    chart: panel.chart,
    timeColumn: panel.timeColumn,
  });
  const row = await insert(
    caller,
    {
      name: input.name,
      description: input.description ?? "",
      savedQueryId: panel.savedQueryId!,
      chart: panel.chart as unknown as ChartSettings,
      timeColumn: panel.timeColumn,
    },
    AUDIT_EVENTS.savedPanelCreated,
    { from_dashboard: dashboardId, from_panel: panelId }
  );
  return presentOne(caller, row);
};

export interface UpdateSavedPanelInput {
  name?: string;
  description?: string;
  saved_query_id?: string;
  chart?: ChartSettings;
  time_column?: string | null;
}

const CHANGEABLE = [
  "name",
  "description",
  "saved_query_id",
  "chart",
  "time_column",
] as const;

/** Changes the caller's own saved panel; new settings are checked as a new saved panel's are. */
export const updateSavedPanel = async (
  caller: Caller,
  id: string,
  patch: UpdateSavedPanelInput
): Promise<SavedPanelView> => {
  const found = await findOwned(caller, id);
  const changesSettings =
    patch.saved_query_id !== undefined ||
    patch.chart !== undefined ||
    patch.time_column !== undefined;
  if (changesSettings) {
    await checkOwnPanel(caller, await loadAccess(caller), null, {
      savedQueryId: patch.saved_query_id ?? found.savedQueryId,
      chart: patch.chart ?? found.chart,
      timeColumn:
        patch.time_column !== undefined ? patch.time_column : found.timeColumn,
    });
  }
  const row = await withAudit(async (tx, audit) => {
    await lockRow(tx, id);
    const current = await db.savedPanels.findById(id, tx);
    if (!current || current.ownerId !== caller.userId) throw notFound();
    const updated = await mapUniqueViolation(
      () =>
        db.savedPanels.update(
          id,
          {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && {
              description: patch.description,
            }),
            ...(patch.saved_query_id !== undefined && {
              savedQueryId: patch.saved_query_id,
            }),
            ...(patch.chart !== undefined && { chart: asJson(patch.chart) }),
            ...(patch.time_column !== undefined && {
              timeColumn: patch.time_column,
            }),
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.savedPanelUpdated,
      resourceType: "saved_panel",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        ...auditMetadata(updated),
        ...(patch.name !== undefined &&
          patch.name !== current.name && { previous_name: current.name }),
        changed: CHANGEABLE.filter((field) => patch[field] !== undefined),
      },
    });
    return updated;
  });
  return presentOne(caller, row);
};

/** Deletes a saved panel: its owner may, and so may a holder of `zeteo.dashboards.write`. Anyone else is told it does not exist. */
export const deleteSavedPanel = async (
  caller: Caller,
  id: string
): Promise<void> => {
  const found = await db.savedPanels.findById(id);
  if (!found || !mayManage(caller, found, DASHBOARDS_WRITE)) throw notFound();
  await withAudit(async (tx, audit) => {
    await lockRow(tx, id);
    const current = await db.savedPanels.findById(id, tx);
    if (!current) throw notFound();
    await db.savedPanels.remove(id, tx);
    audit({
      action: AUDIT_EVENTS.savedPanelDeleted,
      resourceType: "saved_panel",
      resourceId: id,
      actorId: caller.userId,
      metadata: auditMetadata(current),
    });
  });
};

/** Why a decision other than `ok` stops an action: the 403 for what the caller's grants cannot run, else the 400 `invalid_panel`. */
export const refusalOf = (decision: PanelDecision): Error => {
  if (decision.state === "not_accessible") {
    return new SavedQueryNotAccessibleError();
  }
  return new InvalidPanelError(
    decision.message ?? "This saved panel is not available",
    decision.problems ?? [{ setting: "saved_panel", problem: decision.state }]
  );
};

/**
 * The caller's own copy of a saved panel they can see: the same saved query,
 * chart and time column, checked as a new saved panel of theirs is (the reach
 * rule for them, and that they can run it).
 */
export const copySavedPanel = async (
  caller: Caller,
  id: string,
  name: string
): Promise<SavedPanelView> => {
  const access = await loadAccess(caller);
  const source = await findSavedPanelForViewer(caller, id, access.groupIds);
  const savedQuery =
    source.savedQueryId === null
      ? null
      : await db.savedQueries.findById(source.savedQueryId);
  if (!savedQuery) {
    throw new InvalidPanelError("The saved panel's saved query was deleted", [
      { setting: "saved_query", problem: "not_available" },
    ]);
  }
  const decision = await decideNewPanel(caller, access, {
    savedQuery,
    chart: source.chart,
    timeColumn: source.timeColumn,
    timeRange: null,
  });
  if (decision.state !== "ok") throw refusalOf(decision);
  const row = await insert(
    caller,
    {
      name,
      description: source.description,
      savedQueryId: savedQuery.id,
      chart: source.chart as unknown as ChartSettings,
      timeColumn: source.timeColumn,
    },
    AUDIT_EVENTS.savedPanelCopied,
    { copied_from: source.id }
  );
  return presentOne(caller, row);
};

// --- Shares and transfer -------------------------------------------------

/**
 * The saved panel, when the caller may manage it with `permission`. One they
 * may see but not change (`zeteo.dashboards.read` alone, for a change) is a
 * 403; anyone else, a recipient included, gets the one 404.
 */
const findManaged = async (
  caller: Caller,
  id: string,
  permission: ManagePermission
): Promise<SavedPanel> => {
  const row = await db.savedPanels.findById(id);
  if (!row) throw notFound();
  if (mayManage(caller, row, permission)) return row;
  if (hasPermission(caller.permissions, DASHBOARDS_READ)) {
    throw new ForbiddenError(`Requires the ${permission} permission`);
  }
  throw notFound();
};

/** Locks the saved panel and reads it again: the 404 if it is gone, or if the caller may no longer manage it. */
const lockManaged = async (
  tx: Prisma.TransactionClient,
  caller: Caller,
  id: string
): Promise<SavedPanel> => {
  await lockRow(tx, id);
  const current = await db.savedPanels.findById(id, tx);
  if (!current || !mayManage(caller, current, DASHBOARDS_WRITE)) {
    throw notFound();
  }
  return current;
};

const shareViewsOf = async (id: string): Promise<ShareView[]> =>
  shareViews(await db.savedPanels.listShares(id));

/** The saved panel's shares: for its owner, or a holder of `zeteo.dashboards.read`. */
export const listShares = async (
  caller: Caller,
  id: string
): Promise<ShareView[]> => {
  const row = await findManaged(caller, id, DASHBOARDS_READ);
  return shareViewsOf(row.id);
};

/**
 * Makes the saved panel's shares exactly `principals`: for its owner, or a
 * holder of `zeteo.dashboards.write`. Every group being added must be global
 * or of the caller's signed-in organization. Recipients' access is not
 * checked: each panel decides as they look.
 */
export const replaceShares = async (
  caller: Caller,
  id: string,
  principals: SharePrincipal[]
): Promise<{ data: ShareView[] }> => {
  const found = await findManaged(caller, id, DASHBOARDS_WRITE);
  if (includesOwner(principals, found.ownerId)) throw ownerShareError(NOUN);
  const existing = await db.savedPanels.listShares(id);
  // Tereo is asked here, before the transaction.
  const newGroups = await checkNewGroups(
    caller,
    principals,
    idsOfType(existing, "group")
  );
  await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (includesOwner(principals, current.ownerId)) {
      throw ownerShareError(NOUN);
    }
    const changes = await db.savedPanels.replaceShares(
      tx,
      id,
      principals,
      caller.userId
    );
    assertGroupsChecked(changes.added, newGroups);
    if (changes.added.length > 0 || changes.removed.length > 0) {
      audit({
        action: AUDIT_EVENTS.savedPanelShared,
        resourceType: "saved_panel",
        resourceId: id,
        actorId: caller.userId,
        metadata: {
          ...auditMetadata(current),
          added: changes.added,
          removed: changes.removed,
        },
      });
    }
  });
  return { data: await shareViewsOf(id) };
};

/**
 * Makes `userId` the saved panel's owner: for its owner, or a holder of
 * `zeteo.dashboards.write`. A service account cannot own one handed over, and
 * the new owner must not already have one of that name. With `keepAccess`,
 * the previous owner keeps a direct share.
 */
export const transferSavedPanel = async (
  caller: Caller,
  id: string,
  { userId, keepAccess }: { userId: string; keepAccess: boolean }
): Promise<SavedPanelView> => {
  const found = await findManaged(caller, id, DASHBOARDS_WRITE);
  if (found.ownerId === userId) throw alreadyOwnerError(NOUN);
  // Tereo is asked here, before the transaction.
  await checkTransferTarget(userId, NOUN);
  const row = await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (current.ownerId === userId) throw alreadyOwnerError(NOUN);
    const updated = await mapUniqueViolation(
      () =>
        db.savedPanels.transfer(
          tx,
          id,
          userId,
          keepAccess ? current.ownerId : null
        ),
      transferNameTaken(NOUN),
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.savedPanelTransferred,
      resourceType: "saved_panel",
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
  return presentOne(caller, row);
};

/** The most rows a preview returns. */
export const PREVIEW_LIMIT = 5000;

/**
 * A saved panel ready for `runQuery` as the caller: its saved query's JSON
 * with the time filter of `timeRange` when the saved panel has a time column,
 * and `limit` at most `PREVIEW_LIMIT`. Decided as a panel is: what the caller
 * cannot run is the 403, whatever the cause; what the owners broke is told.
 */
export const savedPanelToPreview = async (
  caller: Caller,
  id: string,
  timeRange: TimeRangeKey | null
): Promise<{
  body: Record<string, unknown>;
  savedQuery: { id: string; sourceId: string };
}> => {
  const row = await findSavedPanelForViewer(caller, id);
  const decision = await decideSavedPanel(caller, row, timeRange);
  if (decision.state !== "ok") throw refusalOf(decision);
  const { savedQuery, timeColumn } = decision;
  const filtered =
    timeColumn !== undefined && timeRange !== null
      ? withTimeFilter(savedQuery.query, timeColumn, timeRange)
      : savedQuery.query;
  const stored = (filtered as { limit?: unknown }).limit;
  return {
    body: {
      ...(filtered as Record<string, unknown>),
      limit:
        typeof stored === "number" && stored < PREVIEW_LIMIT
          ? stored
          : PREVIEW_LIMIT,
    },
    savedQuery: { id: savedQuery.id, sourceId: savedQuery.sourceId },
  };
};

export type { ShareView, SharePrincipal };
