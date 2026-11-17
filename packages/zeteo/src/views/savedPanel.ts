import type { SavedPanel } from "../../prisma/generated/client/index.js";
import type { PanelDecision } from "../dashboards/decide.js";
import type { ChartProblem } from "../dashboards/chart.js";

export interface SavedPanelViewOptions {
  /** From the directory; null when it could not be looked up. */
  ownerName: string | null;
  /** How many shares it has; given only when the viewer may see the share list (the owner, or `zeteo.dashboards.read`). */
  shareCount?: number;
  /** How many dashboards link it; given only to the owner and holders of `zeteo.dashboards.read`. */
  usedByDashboards?: number;
  /** When it was first shared with the viewer; null for an owner or an admin it was not shared with. */
  sharedAt?: Date | null;
}

/**
 * A saved panel as a viewer sees it, with the decision of whether they can
 * run it. What it shows and what it is built on (chart, time column, saved
 * query id) only when `ok`; the keys are left out otherwise, never null.
 * Neither the saved query's name nor anything of why a viewer cannot run it
 * is carried.
 */
export const savedPanelView = (
  row: SavedPanel,
  decision: PanelDecision,
  { ownerName, shareCount, usedByDashboards, sharedAt }: SavedPanelViewOptions
) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  owner: { id: row.ownerId, name: ownerName },
  state: decision.state,
  ...(decision.message !== undefined && { message: decision.message }),
  ...(decision.state === "ok" && {
    chart: decision.chart,
    ...(decision.timeColumn !== undefined && {
      time_column: decision.timeColumn,
    }),
    saved_query_id: decision.savedQuery.id,
  }),
  ...(decision.problems && { problems: decision.problems as ChartProblem[] }),
  ...(usedByDashboards !== undefined && {
    used_by: { dashboards: usedByDashboards },
  }),
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  ...(sharedAt && { shared_at: sharedAt.toISOString() }),
  ...(shareCount !== undefined && { share_count: shareCount }),
});

export type SavedPanelView = ReturnType<typeof savedPanelView>;
