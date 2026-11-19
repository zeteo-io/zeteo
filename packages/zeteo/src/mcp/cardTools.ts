import { TimeColumnSchema } from "../routes/v1/dashboards/dashboard/panels/schemas.js";
import { findSavedPanelForViewer, refusalOf } from "../saved-panels/service.js";
import { findDashboardForViewer, getDashboard } from "../dashboards/service.js";
import { TimeRangeSchema } from "../routes/v1/dashboards/schemas.js";
import { runDashboard, type PanelLine } from "../dashboards/run.js";
import { chartProblems, chartSchema } from "../dashboards/chart.js";
import { QUERY_TOOL_TIMEOUT_MS, QueryInput } from "./queryTool.js";
import { previewRun, type PreviewRun } from "./savedPanelTools.js";
import { DASHBOARD_CARD_URI, PANEL_CARD_URI } from "./card.js";
import { MCP_USE } from "../definitions/tereoDeclaration.js";
import { decideSavedPanel } from "../dashboards/decide.js";
import { ValidationError } from "../utils/errors.js";
import { runQuery } from "../engine/index.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { requireDataRead } from "./caller.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";

/** The most panels one `card_dashboard` call runs. */
export const CARD_PANELS_PER_CALL = 4;

/** The most a `card_dashboard` result's lines may carry, under the server's 2 MB result cap. */
export const CARD_RESULT_BYTES = Math.floor(1.9 * 1024 * 1024);

const CARD_ONLY = "Used by zeteo's preview card; not for answering questions.";

const Id = (what: string) => z.string().min(1).max(64).describe(what);

/** A line too large to send, as the card reads it. */
interface TooLargeLine {
  id: string;
  state: "too_large";
}

/**
 * The tools zeteo's preview card calls to draw a panel or a dashboard, run as
 * the viewer with their own grants: `card_panel_rows` (a panel's rows) and
 * `card_dashboard` (a dashboard's layout, or the rows of up to four of its
 * panels). Their results are for the card, not a model: defined only when the
 * card is served, and visible to the card's app alone.
 */
export const defineCardTools = (mcp: TereoMcp): void => {
  mcp.define({
    name: "card_panel_rows",
    ui: { resourceUri: PANEL_CARD_URI, visibility: ["app"] },
    title: "A panel's rows for the preview card",
    description: `${CARD_ONLY} Give saved_panel_id alone, or saved_query_id or query (not saved) with chart, and optionally time_column with time_range. Returns { title, chart, columns, rows, truncated, problems }.`,
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: z.strictObject({
      saved_panel_id: Id("The saved panel to draw").optional(),
      saved_query_id: Id("The saved query to run").optional(),
      query: QueryInput.optional().describe("A query that is not saved"),
      chart: chartSchema.optional(),
      time_column: TimeColumnSchema.optional(),
      time_range: TimeRangeSchema.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const byPanel = input.saved_panel_id !== undefined;
        const bySavedQuery = input.saved_query_id !== undefined;
        const byQuery = input.query !== undefined;
        const extra =
          bySavedQuery ||
          byQuery ||
          input.chart !== undefined ||
          input.time_column !== undefined ||
          input.time_range !== undefined;
        const preview = bySavedQuery !== byQuery && input.chart !== undefined;
        if (byPanel ? extra : !preview) {
          throw new ValidationError(
            "Give saved_panel_id alone, or saved_query_id or query with chart"
          );
        }

        let title: string | null = null;
        let chart;
        let run: PreviewRun;
        if (input.saved_panel_id !== undefined) {
          // Decided as a panel is: the saved query a shared saved panel reaches
          // need not be shared with the viewer itself.
          const row = await findSavedPanelForViewer(
            caller,
            input.saved_panel_id
          );
          const decision = await decideSavedPanel(caller, row, null);
          if (decision.state !== "ok") throw refusalOf(decision);
          title = row.name;
          chart = decision.chart;
          run = {
            body: decision.savedQuery.query as Record<string, unknown>,
            savedQuery: {
              id: decision.savedQuery.id,
              sourceId: decision.savedQuery.sourceId,
            },
          };
        } else {
          // As preview_panel runs it: a query that is not saved runs as the
          // query tool would, with the viewer's own grants.
          chart = input.chart!;
          run = await previewRun(caller, input);
        }
        const result = await runQuery({
          caller,
          entryPoint: "mcp",
          body: run.body,
          savedQuery: run.savedQuery,
          signal: ctx.signal,
        });
        return {
          title,
          chart,
          columns: result.columns,
          rows: result.rows,
          truncated: result.truncated,
          problems: chartProblems(chart, result.columns, run.body),
        };
      }),
  });

  mcp.define({
    name: "card_dashboard",
    ui: { resourceUri: DASHBOARD_CARD_URI, visibility: ["app"] },
    title: "A dashboard for the preview card",
    description: `${CARD_ONLY} Without panel_ids, returns the dashboard's layout { id, name, url, time_range, panels } and runs nothing. With panel_ids (1-${CARD_PANELS_PER_CALL} of its panels), runs them and returns { panels } with one line each.`,
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: z.strictObject({
      dashboard_id: Id("The dashboard's id"),
      panel_ids: z
        .array(Id("A panel's id"))
        .optional()
        .describe(`1-${CARD_PANELS_PER_CALL} of the dashboard's panels to run`),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const ids = input.panel_ids;
        if (ids === undefined) {
          const view = await getDashboard(caller, input.dashboard_id);
          return {
            id: view.id,
            name: view.name,
            url: view.url ?? null,
            time_range: view.time_range,
            panels: view.panels.map((p) => ({
              id: p.id,
              x: p.x,
              y: p.y,
              w: p.w,
              h: p.h,
              title: p.title,
              state: p.state,
              ...(p.chart && { chart: p.chart }),
              ...(p.message !== undefined && { message: p.message }),
            })),
          };
        }
        if (ids.length < 1 || ids.length > CARD_PANELS_PER_CALL) {
          throw new ValidationError(
            `Give 1 to ${CARD_PANELS_PER_CALL} panel_ids`
          );
        }
        if (new Set(ids).size !== ids.length) {
          throw new ValidationError("Name each panel once");
        }
        const dashboard = await findDashboardForViewer(
          caller,
          input.dashboard_id
        );
        const panels: Array<PanelLine | TooLargeLine> = [];
        // `{"panels":[]}`, then each line and its comma.
        let bytes = 13;
        await runDashboard(
          caller,
          dashboard,
          { panels: ids },
          async (line) => {
            if ("done" in line) return;
            const size = Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
            if (bytes + size > CARD_RESULT_BYTES) {
              const tooLarge: TooLargeLine = {
                id: line.panel_id,
                state: "too_large",
              };
              bytes += Buffer.byteLength(JSON.stringify(tooLarge), "utf8") + 1;
              panels.push(tooLarge);
              return;
            }
            bytes += size;
            panels.push(line);
          },
          ctx.signal
        );
        return { panels };
      }),
  });
};
