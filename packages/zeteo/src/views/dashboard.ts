import type { PanelDecision } from "../dashboards/decide.js";
import { panelView } from "./panel.js";
import type {
  Dashboard,
  DashboardPanel,
} from "../../prisma/generated/client/index.js";

export interface DashboardViewOptions {
  /** From the directory; null when it could not be looked up. */
  ownerName: string | null;
  /** How many shares it has; given only when the viewer may see the share list (the owner, or `zeteo.dashboards.read`). */
  shareCount?: number;
  /** When it was first shared with the viewer; null for an owner or an admin it was not shared with. */
  sharedAt?: Date | null;
  /** Where the admin UI is served, when it is (see `uiBaseUrl`). */
  uiBaseUrl: string | null;
}

/**
 * The admin UI's address, `PUBLIC_URL`, when the UI is served from this
 * service (`UI_CLIENT_ID` is set); null otherwise.
 */
export const uiBaseUrl = (env: {
  PUBLIC_URL?: string;
  UI_CLIENT_ID?: string;
}): string | null =>
  env.PUBLIC_URL && env.UI_CLIENT_ID
    ? env.PUBLIC_URL.replace(/\/+$/, "")
    : null;

/** A dashboard as a list shows it: no panels. */
export const dashboardSummary = (
  row: Dashboard,
  { ownerName, shareCount, sharedAt, uiBaseUrl: base }: DashboardViewOptions
) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  owner: { id: row.ownerId, name: ownerName },
  time_range: row.timeRange,
  refresh_seconds: row.refreshSeconds,
  theme: row.theme,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  ...(sharedAt && { shared_at: sharedAt.toISOString() }),
  ...(shareCount !== undefined && { share_count: shareCount }),
  ...(base !== null && { url: `${base}/dashboards/${row.id}` }),
});

export type DashboardSummaryView = ReturnType<typeof dashboardSummary>;

/**
 * A dashboard as a viewer sees it, each panel as `panelView` shows it
 * decided for them. `share_count` is left out unless given, and `url` unless
 * the admin UI is served.
 */
export const dashboardView = (
  row: Dashboard & { panels: DashboardPanel[] },
  decisions: ReadonlyMap<string, PanelDecision>,
  options: DashboardViewOptions
) => ({
  ...dashboardSummary(row, options),
  panels: row.panels.map((p) => panelView(p, decisions.get(p.id)!)),
});

export type DashboardView = ReturnType<typeof dashboardView>;
