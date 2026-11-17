import type { DashboardWithPanels } from "../utils/db/dashboards.js";
import { loadAccess, type CallerAccess } from "../grants/access.js";
import { withTimeFilter, type TimeRangeKey } from "./timeRange.js";
import { SavedQueryNotAccessibleError } from "../utils/errors.js";
import { planSavedAgainst } from "../engine/savedPlan.js";
import type { OutputColumn } from "../adapters/types.js";
import { groupIdsOf } from "../grants/principals.js";
import type { Caller } from "../middleware/auth.js";
import { db } from "../utils/db/index.js";
import { reaches } from "./reach.js";
import type {
  DashboardPanel,
  SavedPanel,
  SavedQuery,
} from "../../prisma/generated/client/index.js";
import {
  loadSourceVisibleCatalog,
  type VisibleCatalog,
} from "../grants/visibleCatalog.js";
import {
  chartProblems,
  chartSchema,
  type ChartProblem,
  type ChartSettings,
} from "./chart.js";

// Whether a viewer can run a panel: one decision for the dashboard read, the
// dashboard run and a saved panel on its own. A panel the viewer cannot run
// for a reason of their grants reveals nothing of why.

export type PanelState =
  | "ok"
  | "not_accessible"
  | "saved_query_deleted"
  | "saved_panel_deleted"
  | "not_available"
  | "needs_update";

export const PANEL_MESSAGES = {
  not_accessible: new SavedQueryNotAccessibleError().message,
  saved_query_deleted: "This panel's saved query was deleted.",
  saved_panel_deleted: "This panel's saved panel was deleted.",
  not_available: "This saved query is no longer available for dashboards.",
  not_shared:
    "This saved panel is no longer shared with this dashboard's owner.",
  needs_update: "This panel needs updating by its owner.",
} as const;

export interface PanelDecision {
  state: PanelState;
  message?: string;
  /** The saved query the panel resolves to, when it still exists. */
  savedQuery?: SavedQuery;
  /** A linked panel's saved panel, when it still exists. */
  savedPanel?: SavedPanel;
  /** `ok` only. */
  chart?: ChartSettings;
  /** `ok` only, when the panel has one. */
  timeColumn?: string;
  /** `needs_update` only, and only for the panel's editor. */
  problems?: ChartProblem[];
}

/**
 * The range the time column is checked with when none is chosen: the column
 * is checked whatever the range, as an `ok` panel shows its name.
 */
const CHECK_RANGE: TimeRangeKey = "last_30_days";

interface DecideContext {
  caller: Caller;
  access: CallerAccess;
  catalogs: ReadonlyMap<string, VisibleCatalog>;
  timeRange: TimeRangeKey | null;
  /** Who chose the chart and time column, and so may see what broke. */
  editorId: string;
}

/** What a panel shows, once resolved to a saved query that reaches. */
interface Resolved {
  savedQuery: SavedQuery;
  savedPanel?: SavedPanel;
  chart: unknown;
  timeColumn: string | null;
}

/** The plan's result columns, or null when the viewer cannot plan it (whatever the cause). */
const planColumns = (
  access: CallerAccess,
  sourceId: string,
  query: unknown,
  catalog: VisibleCatalog
): OutputColumn[] | null => {
  try {
    return planSavedAgainst(
      access,
      { sourceId, query: query as SavedQuery["query"] },
      catalog,
      { sourceId: null, unrecorded: false }
    ).plan.columns;
  } catch (err) {
    if (err instanceof SavedQueryNotAccessibleError) return null;
    throw err;
  }
};

const queryOrder = (query: unknown): { orderBy?: unknown } =>
  typeof query === "object" && query !== null && !Array.isArray(query)
    ? { orderBy: (query as { orderBy?: unknown }).orderBy }
    : {};

/**
 * Steps 4-6: plan the saved query as the viewer, with the time filter when
 * the panel has a time column, then fit the chart to the planned columns
 * (nothing runs). Every panel that gets here does the same work.
 */
const decideRun = (ctx: DecideContext, r: Resolved): PanelDecision => {
  const { savedQuery } = r;
  const found = {
    savedQuery,
    ...(r.savedPanel && { savedPanel: r.savedPanel }),
  };
  const catalog = ctx.catalogs.get(savedQuery.sourceId)!;
  const isEditor = ctx.caller.userId === ctx.editorId;
  const query =
    r.timeColumn === null
      ? savedQuery.query
      : withTimeFilter(
          savedQuery.query,
          r.timeColumn,
          ctx.timeRange ?? CHECK_RANGE
        );
  const columns = planColumns(ctx.access, savedQuery.sourceId, query, catalog);
  if (columns === null) {
    // The editor chose the time column: when only it fails, they are told.
    if (
      isEditor &&
      r.timeColumn !== null &&
      planColumns(
        ctx.access,
        savedQuery.sourceId,
        savedQuery.query,
        catalog
      ) !== null
    ) {
      return {
        ...found,
        state: "needs_update",
        message: PANEL_MESSAGES.needs_update,
        problems: [{ setting: "time_column", problem: "missing_column" }],
      };
    }
    return {
      ...found,
      state: "not_accessible",
      message: PANEL_MESSAGES.not_accessible,
    };
  }
  const chart = chartSchema.safeParse(r.chart);
  const problems: ChartProblem[] = chart.success
    ? chartProblems(chart.data, columns, queryOrder(savedQuery.query))
    : [{ setting: "chart", problem: "wrong_type" }];
  if (!chart.success || problems.length > 0) {
    return {
      ...found,
      state: "needs_update",
      message: PANEL_MESSAGES.needs_update,
      ...(isEditor && { problems }),
    };
  }
  return {
    ...found,
    state: "ok",
    chart: chart.data,
    ...(r.timeColumn !== null && { timeColumn: r.timeColumn }),
  };
};

/** Each distinct source's catalogue as the viewer sees it, loaded once (never null). */
const loadCatalogs = async (
  access: CallerAccess,
  savedQueries: Iterable<SavedQuery>
): Promise<Map<string, VisibleCatalog>> => {
  const catalogs = new Map<string, VisibleCatalog>();
  for (const sourceId of new Set([...savedQueries].map((q) => q.sourceId))) {
    catalogs.set(sourceId, await loadSourceVisibleCatalog(sourceId, access));
  }
  return catalogs;
};

const byId = <T extends { id: string }>(rows: T[]) =>
  new Map(rows.map((r) => [r.id, r]));

const present = <T>(values: Array<T | null | undefined>): T[] => [
  ...new Set(values.filter((v): v is T => v !== null && v !== undefined)),
];

/**
 * The groups of the dashboard's owner that a saved panel share may reach,
 * as of the viewer's organization (the owner's own is not stored).
 */
const ownerGroupIds = (
  caller: Caller,
  access: CallerAccess,
  ownerId: string
): Promise<readonly string[]> =>
  ownerId === caller.userId
    ? Promise.resolve(access.groupIds)
    : groupIdsOf({
        userId: ownerId,
        organizationId: caller.organizationId,
        permissions: [],
        isServiceAccount: false,
      });

/**
 * Every panel of the dashboard decided for `caller`, by panel id. One read
 * each of the viewer's access, the saved panels, the saved queries and the
 * saved panel shares of the dashboard's owner, and each source's catalogue
 * once, all before any panel is planned. Then, per panel:
 *
 * 1. a deleted saved panel or saved query;
 * 2. a linked saved panel neither the dashboard owner's nor shared with them;
 * 3. the reach rule (for the dashboard's owner, and for a linked panel the
 *    saved panel's owner too) for the viewer's organization;
 * 4. the saved query planned as the viewer, with the time filter;
 * 5. the chart against the planned columns;
 * 6. ok.
 *
 * 1-3 depend only on what the owners chose; 4-5 on the viewer's grants, and
 * every cause there is `not_accessible`, except what the dashboard's owner
 * is told of their own settings.
 */
export const decidePanels = async (
  caller: Caller,
  dashboard: DashboardWithPanels,
  timeRange: TimeRangeKey | null
): Promise<Map<string, PanelDecision>> => {
  const access = await loadAccess(caller);
  const savedPanels = byId(
    await db.savedPanels.findByIds(
      present(
        dashboard.panels
          .filter((p) => p.kind === "linked")
          .map((p) => p.savedPanelId)
      )
    )
  );
  const savedQueries = byId(
    await db.savedQueries.findByIds(
      present([
        ...dashboard.panels
          .filter((p) => p.kind === "own")
          .map((p) => p.savedQueryId),
        ...[...savedPanels.values()].map((p) => p.savedQueryId),
      ])
    )
  );
  const foreign = [...savedPanels.values()]
    .filter((p) => p.ownerId !== dashboard.ownerId)
    .map((p) => p.id);
  const sharedWithOwner =
    foreign.length === 0
      ? new Set<string>()
      : await db.savedPanels.sharedWithAmong(
          foreign,
          dashboard.ownerId,
          await ownerGroupIds(caller, access, dashboard.ownerId)
        );
  const ctx: DecideContext = {
    caller,
    access,
    catalogs: await loadCatalogs(access, savedQueries.values()),
    timeRange,
    editorId: dashboard.ownerId,
  };
  const viewerOrganizationId = caller.organizationId;

  const decide = (panel: DashboardPanel): PanelDecision => {
    if (panel.kind === "linked") {
      const savedPanel =
        panel.savedPanelId === null
          ? undefined
          : savedPanels.get(panel.savedPanelId);
      if (!savedPanel) {
        return {
          state: "saved_panel_deleted",
          message: PANEL_MESSAGES.saved_panel_deleted,
        };
      }
      const savedQuery =
        savedPanel.savedQueryId === null
          ? undefined
          : savedQueries.get(savedPanel.savedQueryId);
      if (!savedQuery) {
        return {
          savedPanel,
          state: "saved_query_deleted",
          message: PANEL_MESSAGES.saved_query_deleted,
        };
      }
      if (
        savedPanel.ownerId !== dashboard.ownerId &&
        !sharedWithOwner.has(savedPanel.id)
      ) {
        return {
          savedPanel,
          savedQuery,
          state: "not_available",
          message: PANEL_MESSAGES.not_shared,
        };
      }
      const reach = (panelOwnerId: string) =>
        reaches({ savedQuery, panelOwnerId, viewerOrganizationId });
      if (!reach(savedPanel.ownerId) || !reach(dashboard.ownerId)) {
        return {
          savedPanel,
          savedQuery,
          state: "not_available",
          message: PANEL_MESSAGES.not_available,
        };
      }
      return decideRun(ctx, {
        savedQuery,
        savedPanel,
        chart: savedPanel.chart,
        timeColumn: savedPanel.timeColumn,
      });
    }
    const savedQuery =
      panel.savedQueryId === null
        ? undefined
        : savedQueries.get(panel.savedQueryId);
    if (!savedQuery) {
      return {
        state: "saved_query_deleted",
        message: PANEL_MESSAGES.saved_query_deleted,
      };
    }
    if (
      !reaches({
        savedQuery,
        panelOwnerId: dashboard.ownerId,
        viewerOrganizationId,
      })
    ) {
      return {
        savedQuery,
        state: "not_available",
        message: PANEL_MESSAGES.not_available,
      };
    }
    return decideRun(ctx, {
      savedQuery,
      chart: panel.chart,
      timeColumn: panel.timeColumn,
    });
  };

  return new Map(dashboard.panels.map((p) => [p.id, decide(p)]));
};

/**
 * A saved panel on its own, decided for `caller` as `decidePanels` decides a
 * panel, with the saved panel's owner as the panel's owner and its editor.
 * Whether the caller may see the saved panel at all is the caller's to check.
 */
export const decideSavedPanel = async (
  caller: Caller,
  savedPanel: SavedPanel,
  timeRange: TimeRangeKey | null = null
): Promise<PanelDecision> => {
  const access = await loadAccess(caller);
  const savedQuery =
    savedPanel.savedQueryId === null
      ? null
      : await db.savedQueries.findById(savedPanel.savedQueryId);
  if (!savedQuery) {
    return {
      savedPanel,
      state: "saved_query_deleted",
      message: PANEL_MESSAGES.saved_query_deleted,
    };
  }
  const catalogs = await loadCatalogs(access, [savedQuery]);
  if (
    !reaches({
      savedQuery,
      panelOwnerId: savedPanel.ownerId,
      viewerOrganizationId: caller.organizationId,
    })
  ) {
    return {
      savedPanel,
      savedQuery,
      state: "not_available",
      message: PANEL_MESSAGES.not_available,
    };
  }
  return decideRun(
    { caller, access, catalogs, timeRange, editorId: savedPanel.ownerId },
    {
      savedQuery,
      savedPanel,
      chart: savedPanel.chart,
      timeColumn: savedPanel.timeColumn,
    }
  );
};
