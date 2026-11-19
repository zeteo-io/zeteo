import type { PanelState } from "./api/types";

/** What each state that is not `ok` tells the viewer. */
export const PANEL_COPY: Record<Exclude<PanelState, "ok">, string> = {
  not_accessible:
    "You need expanded permissions to run this saved query. Ask an admin to extend your access.",
  saved_query_deleted: "This panel's saved query was deleted.",
  saved_panel_deleted: "This panel's saved panel was deleted.",
  not_available: "This saved query is no longer available for dashboards.",
  needs_update: "This panel needs updating by its owner.",
};
