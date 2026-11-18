import { SavedQueryNotAccessibleError } from "../utils/errors.js";
import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { DashboardView } from "../views/dashboard.js";
import { chartSchema } from "../dashboards/chart.js";
import { NotFoundError } from "../utils/errors.js";
import { CHART_SUMMARY } from "./reference.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { requireDataRead } from "./caller.js";
import { db } from "../utils/db/index.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";
import {
  PanelTitleSchema,
  PlaceFields,
  TimeColumnSchema,
  placeIssues,
} from "../routes/v1/dashboards/dashboard/panels/schemas.js";
import {
  DashboardDescriptionSchema,
  DashboardNameSchema,
  RefreshSecondsSchema,
  ThemeSchema,
  TimeRangeSchema,
} from "../routes/v1/dashboards/schemas.js";
import {
  addPanel,
  createDashboard,
  deleteDashboard,
  detachPanel,
  getDashboard,
  listDashboards,
  removePanel,
  updateDashboard,
  updatePanel,
} from "../dashboards/service.js";

/** The most one list returns; `truncated` says when it stopped there. */
const LIST_LIMIT = 100;

const Id = (what: string) => z.string().min(1).max(64).describe(what);

/** A view without the owner's id (a model has no use for it). */
const forModel = <T extends { owner: { id: string; name: string | null } }>(
  view: T
) => {
  const { owner, ...rest } = view;
  return { ...rest, owner: { name: owner.name } };
};

/**
 * The tools for dashboards and their panels. Each calls the service the API
 * calls, so the validation, the audit events and what a caller who cannot run
 * a panel is shown are the same.
 */
export const defineDashboardTools = (mcp: TereoMcp): void => {
  mcp.define({
    name: "list_dashboards",
    title: "List dashboards",
    description:
      'List the dashboards you own ("mine", the default) or others shared with you ("shared"). Returns { dashboards: [{ id, name, description, owner, time_range, refresh_seconds, theme, url? }], truncated }; truncated is true when only the first 100 are shown. Give the user a dashboard\'s url, when it has one, to open it.',
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ scope: z.enum(["mine", "shared"]).optional() }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const page = await listDashboards(caller, {
          scope: input.scope ?? "mine",
          limit: LIST_LIMIT,
        });
        return {
          dashboards: page.data.map(forModel),
          truncated: page.nextCursor !== null,
        };
      }),
  });

  mcp.define({
    name: "get_dashboard",
    title: "Get a dashboard",
    description:
      "Read one dashboard by id, with its panels: each with its id, place, title, state and, when you can run it, its chart, time_column and saved_query_id (or saved_panel_id). A panel whose state is not ok carries none of those, and a message that says what to do. Includes url when the dashboard has one.",
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ id: Id("The dashboard's id") }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return forModel(await getDashboard(caller, input.id));
      }),
  });

  mcp.define({
    name: "create_dashboard",
    title: "Create a dashboard",
    description:
      "Create an empty dashboard of your own; add panels with add_panel. time_range is its default range for panels that have a time column (for example last_30_days). refresh_seconds is the auto-refresh interval. Returns the dashboard, with url when it has one: give it to the user.",
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      name: DashboardNameSchema.describe("A name, unique among your own"),
      description: DashboardDescriptionSchema.optional(),
      time_range: TimeRangeSchema.optional(),
      refresh_seconds: RefreshSecondsSchema.optional(),
      theme: ThemeSchema.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return forModel(await createDashboard(caller, input));
      }),
  });

  mcp.define({
    name: "update_dashboard",
    title: "Change a dashboard",
    description:
      "Change the settings of a dashboard you own: name, description, time_range, refresh_seconds, theme. Only what you give changes; panels are changed with add_panel, update_panel and remove_panel.",
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z.strictObject({
      id: Id("The dashboard's id"),
      name: DashboardNameSchema.optional(),
      description: DashboardDescriptionSchema.optional(),
      time_range: TimeRangeSchema.optional(),
      refresh_seconds: RefreshSecondsSchema.optional(),
      theme: ThemeSchema.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const { id, ...patch } = input;
        return forModel(await updateDashboard(caller, id, patch));
      }),
  });

  mcp.define({
    name: "delete_dashboard",
    title: "Delete a dashboard",
    description:
      "Delete a dashboard you own, with its panels, for good. Call it only when the user asks.",
    permission: MCP_USE,
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.strictObject({ id: Id("The dashboard's id") }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        // Own dashboards only over MCP: the service also lets a holder of
        // zeteo.dashboards.write delete another's, which a model must not.
        const row = await db.dashboards.findById(input.id);
        if (!row || row.ownerId !== caller.userId) {
          throw new NotFoundError("Dashboard not found");
        }
        await deleteDashboard(caller, input.id);
        return { deleted: true };
      }),
  });

  mcp.define({
    name: "add_panel",
    title: "Add a panel",
    description: `Add a panel to a dashboard you own: a saved query shown as a chart. Requires dashboard_id, saved_query_id and chart. ${CHART_SUMMARY} time_column, a date or timestamp column path, makes the panel follow the dashboard's time range. Check the chart with preview_panel first. Leave x, y, w and h out to place it in the first free cell at its chart's default size. Returns the panel; what is wrong with the chart or time_column is told as problems. Call query_guide for chart and placement rules.`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z
      .strictObject({
        dashboard_id: Id("The dashboard's id"),
        saved_query_id: Id("The saved query to show"),
        chart: chartSchema,
        time_column: TimeColumnSchema.optional().describe(
          "A date or timestamp column path of the query, filtered by the dashboard's time range"
        ),
        title: PanelTitleSchema.optional(),
        ...PlaceFields,
      })
      .superRefine(placeIssues),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return addPanel(caller, input.dashboard_id, {
          kind: "own",
          savedQueryId: input.saved_query_id,
          chart: input.chart,
          timeColumn: input.time_column,
          title: input.title,
          x: input.x,
          y: input.y,
          w: input.w,
          h: input.h,
        });
      }),
  });

  mcp.define({
    name: "update_panel",
    title: "Change a panel",
    description:
      "Change an own panel of a dashboard you own: its chart, time_column, title or place. Only what you give changes. A linked panel has no chart of its own: change the saved panel, or detach_panel first.",
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z
      .strictObject({
        dashboard_id: Id("The dashboard's id"),
        panel_id: Id("The panel's id"),
        chart: chartSchema.optional(),
        time_column: TimeColumnSchema.optional(),
        title: PanelTitleSchema.optional(),
        ...PlaceFields,
      })
      .superRefine(placeIssues),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const {
          dashboard_id: dashboardId,
          panel_id: panelId,
          ...patch
        } = input;
        // A panel whose saved query the caller can no longer run is not
        // theirs to change: the generic notice, as for every other use of it.
        const view: DashboardView = await getDashboard(caller, dashboardId);
        const panel = view.panels.find((p) => p.id === panelId);
        if (panel?.state === "not_accessible") {
          throw new SavedQueryNotAccessibleError();
        }
        return updatePanel(caller, dashboardId, panelId, patch);
      }),
  });

  mcp.define({
    name: "remove_panel",
    title: "Remove a panel",
    description: "Remove a panel from a dashboard you own.",
    permission: MCP_USE,
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.strictObject({
      dashboard_id: Id("The dashboard's id"),
      panel_id: Id("The panel's id"),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        await removePanel(caller, input.dashboard_id, input.panel_id);
        return { removed: true };
      }),
  });

  mcp.define({
    name: "link_saved_panel",
    title: "Add a saved panel to a dashboard",
    description:
      "Add a saved panel you own or that is shared with you to a dashboard you own, as a linked panel: a later change of the saved panel shows on the dashboard. Leave x, y, w and h out to place it in the first free cell.",
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z
      .strictObject({
        dashboard_id: Id("The dashboard's id"),
        saved_panel_id: Id("The saved panel's id"),
        title: PanelTitleSchema.optional(),
        ...PlaceFields,
      })
      .superRefine(placeIssues),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return addPanel(caller, input.dashboard_id, {
          kind: "linked",
          savedPanelId: input.saved_panel_id,
          title: input.title,
          x: input.x,
          y: input.y,
          w: input.w,
          h: input.h,
        });
      }),
  });

  mcp.define({
    name: "detach_panel",
    title: "Detach a linked panel",
    description:
      "Turn a linked panel of a dashboard you own into an own panel with a copy of the saved panel's saved query, chart and time column, keeping its place and title.",
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      dashboard_id: Id("The dashboard's id"),
      panel_id: Id("The panel's id"),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return detachPanel(caller, input.dashboard_id, input.panel_id);
      }),
  });
};
