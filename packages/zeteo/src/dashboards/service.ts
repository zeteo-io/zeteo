import { DEFAULT_SIZES, type ChartSettings, type ChartType } from "./chart.js";
import { GRID_COLUMNS, MAX_PANELS, placePanel, type Cell } from "./layout.js";
import { TIME_RANGE_KEYS, type TimeRangeKey } from "./timeRange.js";
import { loadAccess, type CallerAccess } from "../grants/access.js";
import { findForViewer } from "../saved-queries/service.js";
import { decideNewPanel, decidePanels } from "./decide.js";
import { hasPermission } from "../utils/permissions.js";
import { db, type Prisma } from "../utils/db/index.js";
import { groupIdsOf } from "../grants/principals.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import { encodeCursor } from "../utils/cursor.js";
import { panelView } from "../views/panel.js";
import { reaches } from "./reach.js";
import env from "../env.js";
import type {
  Dashboard,
  DashboardPanel,
  DashboardTheme,
  SavedPanel,
  SavedQuery,
} from "../../prisma/generated/client/index.js";
import {
  AUDIT_EVENTS,
  DASHBOARDS_READ,
  DASHBOARDS_WRITE,
} from "../definitions/tereoDeclaration.js";
import type {
  DashboardWithPanels,
  PanelInput as DbPanelInput,
} from "../utils/db/dashboards.js";
import {
  isForeignKeyConstraintError,
  mapUniqueViolation,
} from "../utils/prismaErrors.js";
import {
  dashboardSummary,
  dashboardView,
  uiBaseUrl,
} from "../views/dashboard.js";
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
  ConflictError,
  ForbiddenError,
  InvalidPanelError,
  NotFoundError,
  SavedQueryNotAccessibleError,
} from "../utils/errors.js";

const NOUN = "dashboard";

const notFound = () => new NotFoundError("Dashboard not found");

const nameTaken = () =>
  "You already have a dashboard with this name; names are unique whatever their case";

/** The audit metadata every entry carries: the names and ids, never a chart. */
const auditMetadata = (row: Dashboard) => ({
  name: row.name,
  owner_id: row.ownerId,
});

/** The stored time range as a key; null for none (or one this version does not know). */
const timeRangeOf = (stored: string | null): TimeRangeKey | null =>
  TIME_RANGE_KEYS.find((k) => k === stored) ?? null;

type ManagePermission = typeof DASHBOARDS_READ | typeof DASHBOARDS_WRITE;

/**
 * Whether the caller may manage the dashboard's shares or owner with
 * `permission`: they own it, or hold it. With `zeteo.dashboards.read`, it is
 * whether they may see the share list.
 */
const mayManage = (
  caller: Caller,
  row: Dashboard,
  permission: ManagePermission
): boolean =>
  row.ownerId === caller.userId ||
  hasPermission(caller.permissions, permission);

/** Locks the dashboard's row until the transaction ends. */
const lockRow = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT "id" FROM "zeteo"."dashboards" WHERE "id" = ${id}::uuid FOR UPDATE`;

// --- Reading -------------------------------------------------------------

/**
 * The dashboard with its panels, when the caller may see that it exists at
 * all: they own it, it is shared with them or one of their groups, or they
 * hold `zeteo.dashboards.read`. Anything else is the one 404.
 */
export const findDashboardForViewer = async (
  caller: Caller,
  id: string,
  groupIds?: readonly string[]
): Promise<DashboardWithPanels> => {
  const row = await db.dashboards.findWithPanels(id);
  if (!row) throw notFound();
  if (
    row.ownerId === caller.userId ||
    hasPermission(caller.permissions, DASHBOARDS_READ)
  ) {
    return row;
  }
  const groups = groupIds ?? (await groupIdsOf(caller));
  if (await db.dashboards.isSharedWith(id, caller.userId, groups)) return row;
  throw notFound();
};

/** The caller's own dashboard, else the 404 (a recipient or an admin has none to change). */
const findOwned = async (caller: Caller, id: string): Promise<Dashboard> => {
  const row = await db.dashboards.findById(id);
  if (!row || row.ownerId !== caller.userId) throw notFound();
  return row;
};

/** What the viewer's views of `rows` carry besides the dashboard: the owner's name, the share count they may see, when it was shared with them. */
const around = async (caller: Caller, rows: Dashboard[]) => {
  const groupIds = await groupIdsOf(caller);
  const [names, counts, shared] = await Promise.all([
    ownerNames([...new Set(rows.map((r) => r.ownerId))]),
    db.dashboards.countShares(
      rows.filter((r) => mayManage(caller, r, DASHBOARDS_READ)).map((r) => r.id)
    ),
    db.dashboards.sharedAtFor(
      rows.map((r) => r.id),
      caller.userId,
      groupIds
    ),
  ]);
  const options = (row: Dashboard) => ({
    ownerName: names.get(row.ownerId) ?? null,
    sharedAt: shared.get(row.id) ?? null,
    uiBaseUrl: uiBaseUrl(env),
    ...(mayManage(caller, row, DASHBOARDS_READ) && {
      shareCount: counts.get(row.id) ?? 0,
    }),
  });
  return options;
};

/** The dashboard as the caller sees it, each panel decided for them. */
const present = async (caller: Caller, row: DashboardWithPanels) => {
  const options = await around(caller, [row]);
  const decisions = await decidePanels(caller, row, timeRangeOf(row.timeRange));
  return dashboardView(row, decisions, options(row));
};

const presentById = async (caller: Caller, id: string) => {
  const row = await db.dashboards.findWithPanels(id);
  if (!row) throw notFound();
  return present(caller, row);
};

export interface ListDashboardsInput {
  scope: "mine" | "shared" | "all";
  q?: string;
  /** `scope: "all"` only. */
  ownerId?: string;
  cursor?: string;
  limit: number;
}

export const listDashboards = async (
  caller: Caller,
  input: ListDashboardsInput
) => {
  if (
    input.scope === "all" &&
    !hasPermission(caller.permissions, DASHBOARDS_READ)
  ) {
    throw new ForbiddenError(`Requires the ${DASHBOARDS_READ} permission`);
  }
  const page =
    input.scope === "all"
      ? await db.dashboards.listAll({
          ownerId: input.ownerId,
          q: input.q,
          cursor: input.cursor,
          limit: input.limit,
        })
      : await db.dashboards.listVisibleTo({
          userId: caller.userId,
          groupIds: await groupIdsOf(caller),
          scope: input.scope,
          q: input.q,
          cursor: input.cursor,
          limit: input.limit,
        });
  const options = await around(caller, page.rows);
  const last = page.rows.at(-1);
  return {
    data: page.rows.map((r) => dashboardSummary(r, options(r))),
    nextCursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  };
};

export const getDashboard = async (caller: Caller, id: string) =>
  present(caller, await findDashboardForViewer(caller, id));

// --- Panels --------------------------------------------------------------

/** A panel as a request gives it; a missing place is found by `placePanel`. */
export interface Place {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export type PanelInput =
  | ({
      kind: "own";
      savedQueryId: string;
      chart: ChartSettings;
      timeColumn?: string;
      title?: string;
    } & Place)
  | ({ kind: "linked"; savedPanelId: string; title?: string } & Place);

/** A panel of a replacement list that keeps its row: its place and title, and optionally new settings (checked as `updatePanel` checks them). */
export interface ExistingPanelInput {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string | null;
  savedQueryId?: string;
  chart?: ChartSettings;
  timeColumn?: string | null;
}

export type PanelReplacement = PanelInput | ExistingPanelInput;

const isExisting = (p: PanelReplacement): p is ExistingPanelInput => "id" in p;

/** A panel checked against the caller's own objects, not yet placed. */
interface Checked {
  place: Place;
  size: { w: number; h: number };
  data: Omit<DbPanelInput, "x" | "y" | "w" | "h">;
}

const FALLBACK_SIZE = { w: 6, h: 4 };

const sizeOfChart = (chart: unknown) => {
  const type = (chart as { type?: unknown } | null)?.type;
  return typeof type === "string" && type in DEFAULT_SIZES
    ? DEFAULT_SIZES[type as ChartType]
    : FALLBACK_SIZE;
};

const NOT_AVAILABLE_QUERY = [
  { setting: "saved_query", problem: "not_available" },
];

/**
 * That `chart` and `timeColumn` fit the saved query for the caller, who owns
 * the panel: it is visible to them (else the 404), reaches them, runs as
 * them with the time filter of the dashboard's range, and the chart fits what
 * it returns. Their own objects, so what is wrong is told: `invalid_panel`
 * with the problems, except a saved query they cannot run.
 */
const checkOwnPanel = async (
  caller: Caller,
  access: CallerAccess,
  timeRange: TimeRangeKey | null,
  p: { savedQueryId: string | null; chart: unknown; timeColumn: string | null }
): Promise<SavedQuery> => {
  if (p.savedQueryId === null) {
    throw new InvalidPanelError(
      "The panel's saved query was deleted",
      NOT_AVAILABLE_QUERY
    );
  }
  const savedQuery = await findForViewer(
    caller,
    p.savedQueryId,
    access.groupIds
  );
  const decision = await decideNewPanel(caller, access, {
    savedQuery,
    chart: p.chart,
    timeColumn: p.timeColumn,
    timeRange,
  });
  switch (decision.state) {
    case "ok":
      return savedQuery;
    case "not_accessible":
      throw new SavedQueryNotAccessibleError();
    case "not_available":
      throw new InvalidPanelError(
        "This saved query is not available for dashboards",
        NOT_AVAILABLE_QUERY
      );
    default:
      throw new InvalidPanelError(
        "The panel's settings do not fit its saved query",
        decision.problems ?? []
      );
  }
};

/**
 * The saved panel a linked panel points at: the caller's own or shared with
 * them (else the 404), whose saved query still exists and reaches both the
 * caller and the saved panel's owner (else `invalid_panel`).
 */
const checkLinkedPanel = async (
  caller: Caller,
  access: CallerAccess,
  savedPanelId: string
): Promise<SavedPanel> => {
  const savedPanel = await db.savedPanels.findById(savedPanelId);
  if (
    !savedPanel ||
    (savedPanel.ownerId !== caller.userId &&
      !(
        await db.savedPanels.sharedWithAmong(
          [savedPanelId],
          caller.userId,
          access.groupIds
        )
      ).has(savedPanelId))
  ) {
    throw new NotFoundError("Saved panel not found");
  }
  const savedQuery =
    savedPanel.savedQueryId === null
      ? null
      : await db.savedQueries.findById(savedPanel.savedQueryId);
  const reach = (panelOwnerId: string) =>
    savedQuery !== null &&
    reaches({
      savedQuery,
      panelOwnerId,
      viewerOrganizationId: caller.organizationId,
    });
  if (!reach(caller.userId) || !reach(savedPanel.ownerId)) {
    throw new InvalidPanelError("This saved panel is not available", [
      { setting: "saved_panel", problem: "not_available" },
    ]);
  }
  return savedPanel;
};

const asJson = (chart: ChartSettings) =>
  chart as unknown as Prisma.InputJsonObject;

const checkPanels = async (
  caller: Caller,
  access: CallerAccess,
  timeRange: TimeRangeKey | null,
  inputs: readonly PanelInput[]
): Promise<Checked[]> => {
  const checked: Checked[] = [];
  for (const input of inputs) {
    const { x, y, w, h, title } = input;
    const place = { x, y, w, h };
    if (input.kind === "own") {
      await checkOwnPanel(caller, access, timeRange, {
        savedQueryId: input.savedQueryId,
        chart: input.chart,
        timeColumn: input.timeColumn ?? null,
      });
      checked.push({
        place,
        size: DEFAULT_SIZES[input.chart.type],
        data: {
          kind: "own",
          title: title ?? null,
          savedQueryId: input.savedQueryId,
          chart: asJson(input.chart),
          timeColumn: input.timeColumn ?? null,
        },
      });
    } else {
      const savedPanel = await checkLinkedPanel(
        caller,
        access,
        input.savedPanelId
      );
      checked.push({
        place,
        size: sizeOfChart(savedPanel.chart),
        data: {
          kind: "linked",
          title: title ?? null,
          savedPanelId: savedPanel.id,
        },
      });
    }
  }
  return checked;
};

/** The checked panels with their places: the given ones, else the first free cell among those before. */
const layOut = (
  existing: readonly Cell[],
  checked: readonly Checked[]
): DbPanelInput[] => {
  const cells = [...existing];
  return checked.map(({ place, size, data }) => {
    const positioned = place.x !== undefined && place.y !== undefined;
    const w =
      place.w ??
      (positioned ? Math.min(size.w, GRID_COLUMNS - place.x!) : size.w);
    const h = place.h ?? size.h;
    const at = positioned
      ? { x: place.x!, y: place.y! }
      : placePanel(cells, { w, h });
    const cell = { ...at, w, h };
    cells.push(cell);
    return { ...data, ...cell };
  });
};

/** A deleted saved query or saved panel between the check and the write. */
const orConflict = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      throw new ConflictError(
        "A saved query or saved panel of a panel was deleted while saving; retry"
      );
    }
    throw err;
  }
};

// --- Dashboards ----------------------------------------------------------

export interface CreateDashboardInput {
  name: string;
  description?: string;
  time_range?: TimeRangeKey | null;
  refresh_seconds?: number | null;
  theme?: DashboardTheme;
  panels?: PanelInput[];
}

/** Creates a dashboard for the caller, with its panels, each checked against their own saved queries and saved panels. */
export const createDashboard = async (
  caller: Caller,
  input: CreateDashboardInput
) => {
  const access = await loadAccess(caller);
  const checked = await checkPanels(
    caller,
    access,
    input.time_range ?? null,
    input.panels ?? []
  );
  const created = await withAudit(async (tx, audit) => {
    const row = await mapUniqueViolation(
      () =>
        db.dashboards.create(
          {
            ownerId: caller.userId,
            name: input.name,
            description: input.description ?? "",
            timeRange: input.time_range ?? null,
            refreshSeconds: input.refresh_seconds ?? null,
            theme: input.theme,
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    const panels = layOut([], checked);
    if (panels.length > 0) {
      await orConflict(() => db.dashboards.replacePanels(tx, row.id, panels));
    }
    audit({
      action: AUDIT_EVENTS.dashboardCreated,
      resourceType: "dashboard",
      resourceId: row.id,
      actorId: caller.userId,
      metadata: { ...auditMetadata(row), panel_count: panels.length },
    });
    return row;
  });
  return presentById(caller, created.id);
};

export interface UpdateDashboardInput {
  name?: string;
  description?: string;
  time_range?: TimeRangeKey | null;
  refresh_seconds?: number | null;
  theme?: DashboardTheme;
  panels?: PanelReplacement[];
}

const CHANGEABLE = [
  "name",
  "description",
  "time_range",
  "refresh_seconds",
  "theme",
  "panels",
] as const;

interface Replacement {
  kept: Array<{
    id: string;
    cell: Cell;
    changes: Prisma.DashboardPanelUpdateInput;
  }>;
  added: Checked[];
}

const TOO_MANY = [{ setting: "panels", problem: "too_many" }];

/**
 * A replacement list checked: an entry with an `id` keeps that panel's row
 * (an id not on this dashboard, or named twice, is `invalid_panel`), changing
 * only what it gives, and is asked nothing unless it gives a new saved query,
 * chart or time column; the others are new panels, checked as a new panel is.
 */
const checkReplacement = async (
  caller: Caller,
  access: CallerAccess,
  timeRange: TimeRangeKey | null,
  current: readonly DashboardPanel[],
  entries: readonly PanelReplacement[]
): Promise<Replacement> => {
  const byId = new Map(current.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const kept: Replacement["kept"] = [];
  const fresh: PanelInput[] = [];
  for (const entry of entries) {
    if (!isExisting(entry)) {
      fresh.push(entry);
      continue;
    }
    const panel = byId.get(entry.id);
    if (!panel || seen.has(entry.id)) {
      throw new InvalidPanelError(
        "A panel is not on this dashboard, or is named twice",
        [{ setting: "panels", problem: "unknown_panel" }]
      );
    }
    seen.add(entry.id);
    const settings =
      entry.savedQueryId !== undefined ||
      entry.chart !== undefined ||
      entry.timeColumn !== undefined;
    if (settings) {
      if (panel.kind === "linked") {
        throw new BadRequestError("invalid_panel", NO_OWN_SETTINGS);
      }
      await checkOwnPanel(caller, access, timeRange, {
        savedQueryId: entry.savedQueryId ?? panel.savedQueryId,
        chart: entry.chart ?? panel.chart,
        timeColumn:
          entry.timeColumn !== undefined ? entry.timeColumn : panel.timeColumn,
      });
    }
    kept.push({
      id: entry.id,
      cell: { x: entry.x, y: entry.y, w: entry.w, h: entry.h },
      changes: {
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
        ...(entry.title !== undefined && { title: entry.title }),
        ...(entry.savedQueryId !== undefined && {
          savedQuery: { connect: { id: entry.savedQueryId } },
        }),
        ...(entry.chart !== undefined && { chart: asJson(entry.chart) }),
        ...(entry.timeColumn !== undefined && {
          timeColumn: entry.timeColumn,
        }),
      },
    });
  }
  return {
    kept,
    added: await checkPanels(caller, access, timeRange, fresh),
  };
};

/** Under the dashboard's lock: drops the panels left out, updates the kept ones in place (ids and stored settings survive), adds the new. */
const applyReplacement = async (
  tx: Prisma.TransactionClient,
  dashboardId: string,
  replacement: Replacement
): Promise<void> => {
  const current = await db.dashboards.findWithPanels(dashboardId, tx);
  const have = new Set(current?.panels.map((p) => p.id));
  if (replacement.kept.some((k) => !have.has(k.id))) {
    throw new ConflictError(
      "The panels changed while saving; load them again and retry"
    );
  }
  const keep = new Set(replacement.kept.map((k) => k.id));
  for (const p of current?.panels ?? []) {
    if (!keep.has(p.id)) await db.dashboards.removePanel(p.id, tx);
  }
  for (const k of replacement.kept) {
    await tx.dashboardPanel.update({ where: { id: k.id }, data: k.changes });
  }
  const laid = layOut(
    replacement.kept.map((k) => k.cell),
    replacement.added
  );
  for (const panel of laid)
    await db.dashboards.addPanel(dashboardId, panel, tx);
};

/** Changes the caller's own dashboard; `panels` replaces the whole list, in the same transaction. */
export const updateDashboard = async (
  caller: Caller,
  id: string,
  patch: UpdateDashboardInput
) => {
  const found = await findOwned(caller, id);
  const range =
    patch.time_range !== undefined
      ? patch.time_range
      : timeRangeOf(found.timeRange);
  const replacement = patch.panels
    ? await checkReplacement(
        caller,
        await loadAccess(caller),
        range,
        (await db.dashboards.findWithPanels(id))?.panels ?? [],
        patch.panels
      )
    : undefined;
  await withAudit(async (tx, audit) => {
    await lockRow(tx, id);
    const current = await db.dashboards.findById(id, tx);
    if (!current || current.ownerId !== caller.userId) throw notFound();
    const updated = await mapUniqueViolation(
      () =>
        db.dashboards.update(
          id,
          {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && {
              description: patch.description,
            }),
            ...(patch.time_range !== undefined && {
              timeRange: patch.time_range,
            }),
            ...(patch.refresh_seconds !== undefined && {
              refreshSeconds: patch.refresh_seconds,
            }),
            ...(patch.theme !== undefined && { theme: patch.theme }),
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    if (replacement) {
      await orConflict(() => applyReplacement(tx, id, replacement));
    }
    audit({
      action: AUDIT_EVENTS.dashboardUpdated,
      resourceType: "dashboard",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        ...auditMetadata(updated),
        ...(patch.name !== undefined &&
          patch.name !== current.name && { previous_name: current.name }),
        changed: CHANGEABLE.filter((field) => patch[field] !== undefined),
        ...(replacement && {
          panel_count: replacement.kept.length + replacement.added.length,
        }),
      },
    });
  });
  return presentById(caller, id);
};

/** Deletes a dashboard: its owner may, and so may a holder of `zeteo.dashboards.write`. Anyone else is told it does not exist. */
export const deleteDashboard = async (
  caller: Caller,
  id: string
): Promise<void> => {
  const found = await db.dashboards.findById(id);
  if (!found || !mayManage(caller, found, DASHBOARDS_WRITE)) throw notFound();
  await withAudit(async (tx, audit) => {
    await lockRow(tx, id);
    const current = await db.dashboards.findById(id, tx);
    if (!current) throw notFound();
    await db.dashboards.remove(id, tx);
    audit({
      action: AUDIT_EVENTS.dashboardDeleted,
      resourceType: "dashboard",
      resourceId: id,
      actorId: caller.userId,
      metadata: auditMetadata(current),
    });
  });
};

/** The caller's own copy of a dashboard they can see: the same panels, each decided for them as they look. */
export const copyDashboard = async (
  caller: Caller,
  id: string,
  name: string
) => {
  const source = await findDashboardForViewer(caller, id);
  const panels: DbPanelInput[] = source.panels.map((p) => ({
    kind: p.kind,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    title: p.title,
    savedQueryId: p.savedQueryId,
    savedPanelId: p.savedPanelId,
    chart: p.chart === null ? null : (p.chart as Prisma.InputJsonValue),
    timeColumn: p.timeColumn,
  }));
  const created = await withAudit(async (tx, audit) => {
    const row = await mapUniqueViolation(
      () =>
        db.dashboards.create(
          {
            ownerId: caller.userId,
            name,
            description: source.description,
            timeRange: source.timeRange,
            refreshSeconds: source.refreshSeconds,
            theme: source.theme,
          },
          tx
        ),
      nameTaken(),
      "conflict"
    );
    if (panels.length > 0) {
      await orConflict(() => db.dashboards.replacePanels(tx, row.id, panels));
    }
    audit({
      action: AUDIT_EVENTS.dashboardCopied,
      resourceType: "dashboard",
      resourceId: row.id,
      actorId: caller.userId,
      metadata: {
        ...auditMetadata(row),
        copied_from: source.id,
        panel_count: panels.length,
      },
    });
    return row;
  });
  return presentById(caller, created.id);
};

// --- One panel -----------------------------------------------------------

/** The panel as the caller sees it, decided with the rest of its dashboard. */
const presentPanel = async (
  caller: Caller,
  dashboardId: string,
  panelId: string
) => {
  const row = await db.dashboards.findWithPanels(dashboardId);
  const panel = row?.panels.find((p) => p.id === panelId);
  if (!row || !panel) throw notFound();
  const decisions = await decidePanels(caller, row, timeRangeOf(row.timeRange));
  return panelView(panel, decisions.get(panelId)!);
};

const panelAudit = (
  caller: Caller,
  row: Dashboard,
  extra: Record<string, unknown>
) => ({
  action: AUDIT_EVENTS.dashboardUpdated,
  resourceType: "dashboard",
  resourceId: row.id,
  actorId: caller.userId,
  metadata: { ...auditMetadata(row), changed: ["panels"], ...extra },
});

/** Adds a panel to the caller's own dashboard, in the first free cell unless it has a place. */
export const addPanel = async (
  caller: Caller,
  dashboardId: string,
  input: PanelInput
) => {
  const found = await findOwned(caller, dashboardId);
  const [checked] = await checkPanels(
    caller,
    await loadAccess(caller),
    timeRangeOf(found.timeRange),
    [input]
  );
  const panel = await withAudit(async (tx, audit) => {
    await lockRow(tx, dashboardId);
    const current = await db.dashboards.findWithPanels(dashboardId, tx);
    if (!current || current.ownerId !== caller.userId) throw notFound();
    if (current.panels.length >= MAX_PANELS) {
      throw new InvalidPanelError(
        `A dashboard holds at most ${MAX_PANELS} panels`,
        TOO_MANY
      );
    }
    const [laid] = layOut(current.panels, [checked!]);
    const added = await orConflict(() =>
      db.dashboards.addPanel(dashboardId, laid!, tx)
    );
    audit(panelAudit(caller, current, { panel_added: added.id }));
    return added;
  });
  return presentPanel(caller, dashboardId, panel.id);
};

export interface UpdatePanelInput extends Place {
  title?: string | null;
  saved_query_id?: string;
  chart?: ChartSettings;
  time_column?: string | null;
}

const NO_OWN_SETTINGS =
  "A linked panel has no chart settings of its own; change the saved panel";

/**
 * Changes a panel of the caller's own dashboard. A new saved query, chart or
 * time column is checked as a new panel is; a title or place changes without
 * asking whether the caller can run it.
 */
export const updatePanel = async (
  caller: Caller,
  dashboardId: string,
  panelId: string,
  patch: UpdatePanelInput
) => {
  const found = await findOwned(caller, dashboardId);
  const panels =
    (await db.dashboards.findWithPanels(dashboardId))?.panels ?? [];
  const panel = panels.find((p) => p.id === panelId);
  if (!panel) throw notFound();
  const changesSettings =
    patch.saved_query_id !== undefined ||
    patch.chart !== undefined ||
    patch.time_column !== undefined;
  if (changesSettings && panel.kind === "linked") {
    throw new BadRequestError("invalid_panel", NO_OWN_SETTINGS);
  }
  const cell = {
    x: patch.x ?? panel.x,
    y: patch.y ?? panel.y,
    w: patch.w ?? panel.w,
    h: patch.h ?? panel.h,
  };
  if (cell.x + cell.w > GRID_COLUMNS) {
    throw new BadRequestError(
      "invalid_panel",
      `A panel must fit the grid: x + w is at most ${GRID_COLUMNS}`
    );
  }
  if (changesSettings) {
    await checkOwnPanel(
      caller,
      await loadAccess(caller),
      timeRangeOf(found.timeRange),
      {
        savedQueryId: patch.saved_query_id ?? panel.savedQueryId,
        chart: patch.chart ?? panel.chart,
        timeColumn:
          patch.time_column !== undefined
            ? patch.time_column
            : panel.timeColumn,
      }
    );
  }
  await withAudit(async (tx, audit) => {
    await lockRow(tx, dashboardId);
    const current = await db.dashboards.findWithPanels(dashboardId, tx);
    if (
      !current ||
      current.ownerId !== caller.userId ||
      !current.panels.some((p) => p.id === panelId)
    ) {
      throw notFound();
    }
    await orConflict(() =>
      db.dashboards.updatePanel(
        panelId,
        {
          ...cell,
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.saved_query_id !== undefined && {
            savedQueryId: patch.saved_query_id,
          }),
          ...(patch.chart !== undefined && { chart: asJson(patch.chart) }),
          ...(patch.time_column !== undefined && {
            timeColumn: patch.time_column,
          }),
        },
        tx
      )
    );
    audit(panelAudit(caller, current, { panel_changed: panelId }));
  });
  return presentPanel(caller, dashboardId, panelId);
};

/** Removes a panel of the caller's own dashboard. */
export const removePanel = async (
  caller: Caller,
  dashboardId: string,
  panelId: string
): Promise<void> => {
  await findOwned(caller, dashboardId);
  await withAudit(async (tx, audit) => {
    await lockRow(tx, dashboardId);
    const current = await db.dashboards.findWithPanels(dashboardId, tx);
    if (
      !current ||
      current.ownerId !== caller.userId ||
      !current.panels.some((p) => p.id === panelId)
    ) {
      throw notFound();
    }
    await db.dashboards.removePanel(panelId, tx);
    audit(panelAudit(caller, current, { panel_removed: panelId }));
  });
};

// --- Shares and transfer -------------------------------------------------

/**
 * The dashboard, when the caller may manage it with `permission`. One they
 * may see but not change (`zeteo.dashboards.read` alone, for a change) is a
 * 403; anyone else, a recipient included, gets the one 404.
 */
const findManaged = async (
  caller: Caller,
  id: string,
  permission: ManagePermission
): Promise<Dashboard> => {
  const row = await db.dashboards.findById(id);
  if (!row) throw notFound();
  if (mayManage(caller, row, permission)) return row;
  if (hasPermission(caller.permissions, DASHBOARDS_READ)) {
    throw new ForbiddenError(`Requires the ${permission} permission`);
  }
  throw notFound();
};

/** Locks the dashboard and reads it again: the 404 if it is gone, or if the caller may no longer manage it. */
const lockManaged = async (
  tx: Prisma.TransactionClient,
  caller: Caller,
  id: string
): Promise<Dashboard> => {
  await lockRow(tx, id);
  const current = await db.dashboards.findById(id, tx);
  if (!current || !mayManage(caller, current, DASHBOARDS_WRITE)) {
    throw notFound();
  }
  return current;
};

const shareViewsOf = async (id: string): Promise<ShareView[]> =>
  shareViews(await db.dashboards.listShares(id));

/** The dashboard's shares: for its owner, or a holder of `zeteo.dashboards.read`. */
export const listShares = async (
  caller: Caller,
  id: string
): Promise<ShareView[]> => {
  const row = await findManaged(caller, id, DASHBOARDS_READ);
  return shareViewsOf(row.id);
};

/**
 * Makes the dashboard's shares exactly `principals`: for its owner, or a
 * holder of `zeteo.dashboards.write`. Every group being added must be global
 * or of the caller's signed-in organization. Recipients' access to the panels
 * is not checked: each panel decides as they look.
 */
export const replaceShares = async (
  caller: Caller,
  id: string,
  principals: SharePrincipal[]
): Promise<{ data: ShareView[] }> => {
  const found = await findManaged(caller, id, DASHBOARDS_WRITE);
  if (includesOwner(principals, found.ownerId)) throw ownerShareError(NOUN);
  const existing = await db.dashboards.listShares(id);
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
    const changes = await db.dashboards.replaceShares(
      tx,
      id,
      principals,
      caller.userId
    );
    // A group removed by someone else meanwhile would be added here unchecked.
    assertGroupsChecked(changes.added, newGroups);
    if (changes.added.length > 0 || changes.removed.length > 0) {
      audit({
        action: AUDIT_EVENTS.dashboardShared,
        resourceType: "dashboard",
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
 * Makes `userId` the dashboard's owner: for its owner, or a holder of
 * `zeteo.dashboards.write`. A service account cannot own one handed over, and
 * the new owner must not already have one of that name. With `keepAccess`,
 * the previous owner keeps a direct share.
 */
export const transferDashboard = async (
  caller: Caller,
  id: string,
  { userId, keepAccess }: { userId: string; keepAccess: boolean }
) => {
  const found = await findManaged(caller, id, DASHBOARDS_WRITE);
  if (found.ownerId === userId) throw alreadyOwnerError(NOUN);
  // Tereo is asked here, before the transaction.
  await checkTransferTarget(userId, NOUN);
  await withAudit(async (tx, audit) => {
    const current = await lockManaged(tx, caller, id);
    if (current.ownerId === userId) throw alreadyOwnerError(NOUN);
    const updated = await mapUniqueViolation(
      () =>
        db.dashboards.transfer(
          tx,
          id,
          userId,
          keepAccess ? current.ownerId : null
        ),
      transferNameTaken(NOUN),
      "conflict"
    );
    audit({
      action: AUDIT_EVENTS.dashboardTransferred,
      resourceType: "dashboard",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        ...auditMetadata(updated),
        from: current.ownerId,
        to: userId,
        keep_access: keepAccess,
      },
    });
  });
  return presentById(caller, id);
};
