import { TimeColumnSchema } from "../routes/v1/dashboards/dashboard/panels/schemas.js";
import { RANGE_TIME_COLUMN, withTimeFilter } from "../dashboards/timeRange.js";
import { TimeRangeSchema } from "../routes/v1/dashboards/schemas.js";
import { chartProblems, chartSchema } from "../dashboards/chart.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { QUERY_TOOL_TIMEOUT_MS, QueryInput } from "./queryTool.js";
import type { TimeRangeKey } from "../dashboards/timeRange.js";
import { savedQueryToRun } from "../saved-queries/service.js";
import { MCP_USE } from "../definitions/tereoDeclaration.js";
import { isMetricBody } from "../adapters/sql/language.js";
import { PANEL_CARD_URI, withCardNote } from "./card.js";
import { LIMIT_PROFILES } from "../engine/limits.js";
import type { Caller } from "../middleware/auth.js";
import { CHART_SUMMARY } from "./reference.js";
import { runQuery } from "../engine/index.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { requireDataRead } from "./caller.js";
import { db } from "../utils/db/index.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";
import {
  SavedPanelDescriptionSchema,
  SavedPanelNameSchema,
} from "../routes/v1/saved-panels/schemas.js";
import {
  createSavedPanel,
  deleteSavedPanel,
  getSavedPanel,
  listSavedPanels,
  updateSavedPanel,
} from "../saved-panels/service.js";

/** The most one list returns; `truncated` says when it stopped there. */
const LIST_LIMIT = 100;

/** The rows a preview returns: enough to see the shape of the data. */
const PREVIEW_ROWS = 20;

const Id = (what: string) => z.string().min(1).max(64).describe(what);

const forModel = <T extends { owner: { id: string; name: string | null } }>(
  view: T
) => {
  const { owner, ...rest } = view;
  return { ...rest, owner: { name: owner.name } };
};

/** What a preview runs: a body as the caller would query it, and the saved query it came from, if any. */
export interface PreviewRun {
  body: Record<string, unknown>;
  savedQuery?: { id: string; sourceId: string };
  /** A metric query given a time column other than "range", or a table query given "range": not filtered, and reported as a problem. */
  wrongTimeColumn?: boolean;
}

/**
 * The run of a preview of `saved_query_id` (run as `run_saved_query` would)
 * or of `query` (run as the `query` tool would, recorded with no saved query),
 * filtered by `time_column` over `time_range` when both are given.
 */
export const previewRun = async (
  caller: Caller,
  input: {
    saved_query_id?: string;
    query?: Record<string, unknown>;
    time_column?: string;
    time_range?: TimeRangeKey;
  }
): Promise<PreviewRun> => {
  let run: PreviewRun;
  if (input.query !== undefined) {
    run = { body: input.query };
  } else {
    const found = await savedQueryToRun(caller, input.saved_query_id!, {});
    run = { body: found.body, savedQuery: found.savedQuery };
  }
  if (input.time_column !== undefined && input.time_range !== undefined) {
    const isRange = input.time_column === RANGE_TIME_COLUMN;
    if (isMetricBody(run.body) ? !isRange : isRange) {
      run.wrongTimeColumn = true;
      return run;
    }
    run.body = withTimeFilter(
      run.body,
      input.time_column,
      input.time_range
    ) as Record<string, unknown>;
  }
  return run;
};

/** The tools for saved panels, and `preview_panel`, which checks a chart against a query's result (saved or not), with nothing saved. */
export const defineSavedPanelTools = (mcp: TereoMcp, cards: boolean): void => {
  mcp.define({
    name: "list_saved_panels",
    title: "List saved panels",
    description:
      'List the saved panels (a saved query with its chart, reusable on many dashboards) you own ("mine", the default) or others shared with you ("shared"). Returns { saved_panels: [{ id, name, description, owner, state, chart?, time_column?, saved_query_id? }], truncated }. A saved panel whose state is not ok carries no chart, time column or ids.',
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ scope: z.enum(["mine", "shared"]).optional() }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const page = await listSavedPanels(caller, {
          scope: input.scope ?? "mine",
          limit: LIST_LIMIT,
        });
        return {
          saved_panels: page.data.map(forModel),
          truncated: page.nextCursor !== null,
        };
      }),
  });

  mcp.define({
    name: "get_saved_panel",
    ...(cards && { ui: { resourceUri: PANEL_CARD_URI } }),
    title: "Get a saved panel",
    description: withCardNote(
      cards,
      "panel",
      "Read one saved panel by id: its name, description, owner and, when you can run it, its chart, time_column and saved_query_id."
    ),
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ id: Id("The saved panel's id") }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return forModel(await getSavedPanel(caller, input.id));
      }),
  });

  mcp.define({
    name: "create_saved_panel",
    ...(cards && { ui: { resourceUri: PANEL_CARD_URI } }),
    title: "Save a panel",
    description: withCardNote(
      cards,
      "panel",
      "Save a chart over a saved query under a name, to reuse on dashboards with link_saved_panel. Call it only when the user asks. The chart and time_column are checked as add_panel checks them."
    ),
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      name: SavedPanelNameSchema.describe("A name, unique among your own"),
      description: SavedPanelDescriptionSchema.optional(),
      saved_query_id: Id("The saved query to show"),
      chart: chartSchema,
      time_column: TimeColumnSchema.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return forModel(
          await createSavedPanel(caller, {
            name: input.name,
            description: input.description ?? "",
            savedQueryId: input.saved_query_id,
            chart: input.chart,
            timeColumn: input.time_column,
          })
        );
      }),
  });

  mcp.define({
    name: "update_saved_panel",
    ...(cards && { ui: { resourceUri: PANEL_CARD_URI } }),
    title: "Change a saved panel",
    description: withCardNote(
      cards,
      "panel",
      "Change the name, description, saved query, chart or time column of a saved panel you own. Only what you give changes, and every dashboard that links it shows the change."
    ),
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z.strictObject({
      id: Id("The saved panel's id"),
      name: SavedPanelNameSchema.optional(),
      description: SavedPanelDescriptionSchema.optional(),
      saved_query_id: Id("The saved query to show").optional(),
      chart: chartSchema.optional(),
      time_column: TimeColumnSchema.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const { id, ...patch } = input;
        return forModel(await updateSavedPanel(caller, id, patch));
      }),
  });

  mcp.define({
    name: "delete_saved_panel",
    title: "Delete a saved panel",
    description:
      "Delete a saved panel you own, for good. Call it only when the user asks.",
    permission: MCP_USE,
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.strictObject({ id: Id("The saved panel's id") }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        // Own saved panels only over MCP: the service also lets a holder of
        // zeteo.dashboards.write delete another's, which a model must not.
        const row = await db.savedPanels.findById(input.id);
        if (!row || row.ownerId !== caller.userId) {
          throw new NotFoundError("Saved panel not found");
        }
        await deleteSavedPanel(caller, input.id);
        return { deleted: true };
      }),
  });

  mcp.define({
    name: "preview_panel",
    ...(cards && { ui: { resourceUri: PANEL_CARD_URI } }),
    title: "Preview a panel",
    description: withCardNote(
      cards,
      "panel",
      `Check a chart against a query's result: give saved_query_id or query (the query tool's JSON, not saved), never both. To show the user a chart, preview it with query; save it only when they want to keep it. ${CHART_SUMMARY} Give time_range with time_column to see it filtered as a dashboard would. Returns { columns, row_count, truncated, rows (the first ${PREVIEW_ROWS}), problems }; each problem names the chart setting at fault (for example y.0) and is missing_column, wrong_type or needs_order. Empty problems means the chart fits. A query without its own limit reads at most ${LIMIT_PROFILES.mcp.defaultRows} rows here, so row_count stops at ${LIMIT_PROFILES.mcp.defaultRows} and truncated is true when there are more. That is the preview's limit, not the saved query's or the dashboard's: on a dashboard the same panel reads up to ${LIMIT_PROFILES.dashboard.defaultRows.toLocaleString("en-US")} rows, or the saved query's own limit up to ${LIMIT_PROFILES.dashboard.maxRows.toLocaleString("en-US")}. Call query_guide for the language, chart and placement rules.`
    ),
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: z.strictObject({
      saved_query_id: Id("The saved query to run").optional(),
      query: QueryInput.optional().describe(
        "A query to run as the query tool would, without saving it"
      ),
      chart: chartSchema,
      time_column: TimeColumnSchema.optional(),
      time_range: TimeRangeSchema.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        if (input.saved_query_id !== undefined && input.query !== undefined) {
          throw new ValidationError("Give saved_query_id or query, not both");
        }
        if (input.saved_query_id === undefined && input.query === undefined) {
          throw new ValidationError(
            "Give either saved_query_id or query, exactly one"
          );
        }
        const run = await previewRun(caller, input);
        const result = await runQuery({
          caller,
          entryPoint: "mcp",
          body: run.body,
          savedQuery: run.savedQuery,
          signal: ctx.signal,
        });
        return {
          columns: result.columns,
          row_count: result.rows.length,
          truncated: result.truncated,
          rows: result.rows.slice(0, PREVIEW_ROWS),
          problems: [
            ...(run.wrongTimeColumn
              ? [{ setting: "time_column", problem: "wrong_type" as const }]
              : []),
            ...chartProblems(input.chart, result.columns, run.body),
          ],
        };
      }),
  });
};
