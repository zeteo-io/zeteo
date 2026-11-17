import type { ChartProblem, ChartSettings } from "../dashboards/chart.js";
import type { PanelDecision, PanelState } from "../dashboards/decide.js";
import type {
  DashboardPanel,
  PanelKind,
} from "../../prisma/generated/client/index.js";

/** What a `not_available` panel with nothing of its own to call it by is titled: a saved query of someone else is not named. */
export const UNTITLED = "Untitled panel";

export interface PanelView {
  id: string;
  kind: PanelKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The panel's own title, else its saved panel's or saved query's name (not a third party's, for a `not_available` panel); null when none is left. */
  title: string | null;
  state: PanelState;
  message?: string;
  chart?: ChartSettings;
  time_column?: string;
  saved_query_id?: string;
  saved_panel_id?: string;
  problems?: ChartProblem[];
}

/**
 * A panel as a viewer sees it. What it shows and what it is built on (chart,
 * time column, saved query and saved panel ids) only when `ok`; the keys are
 * left out otherwise, never null. `problems` only when the decision carries
 * them, which is for the panel's editor alone.
 */
export const panelView = (
  panel: DashboardPanel,
  decision: PanelDecision
): PanelView => ({
  id: panel.id,
  kind: panel.kind,
  x: panel.x,
  y: panel.y,
  w: panel.w,
  h: panel.h,
  title:
    panel.title ??
    decision.savedPanel?.name ??
    decision.savedQuery?.name ??
    (decision.state === "not_available" ? UNTITLED : null),
  state: decision.state,
  ...(decision.message !== undefined && { message: decision.message }),
  ...(decision.state === "ok" && {
    ...(decision.chart && { chart: decision.chart }),
    ...(decision.timeColumn !== undefined && {
      time_column: decision.timeColumn,
    }),
    ...(decision.savedQuery && { saved_query_id: decision.savedQuery.id }),
    ...(decision.savedPanel && { saved_panel_id: decision.savedPanel.id }),
  }),
  ...(decision.problems && { problems: decision.problems }),
});
