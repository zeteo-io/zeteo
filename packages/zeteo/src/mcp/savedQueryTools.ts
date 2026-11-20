import { SavedQueryPagingFields } from "../routes/v1/saved-queries/saved-query/schemas.js";
import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { SavedQueryView } from "../views/savedQuery.js";
import { NotFoundError } from "../utils/errors.js";
import { runQuery } from "../engine/index.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { requireDataRead } from "./caller.js";
import { db } from "../utils/db/index.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";
import {
  SavedQueryDescriptionSchema,
  SavedQueryNameSchema,
} from "../routes/v1/saved-queries/schemas.js";
import {
  createSavedQuery,
  deleteSavedQuery,
  getSavedQuery,
  listSavedQueries,
  savedQueryToRun,
  updateSavedQuery,
} from "../saved-queries/service.js";
import {
  QUERY_LANGUAGE_SUMMARY,
  QUERY_TOOL_TIMEOUT_MS,
  QueryInput,
} from "./queryTool.js";

/** The most one list returns; `truncated` says when it stopped there. */
const LIST_LIMIT = 100;

const Id = z.string().min(1).max(64).describe("The saved query's id");

/** The view as the API gives it, without the owner's id (a model has no use for it). */
const forModel = (view: SavedQueryView) => {
  const { owner, ...rest } = view;
  return { ...rest, owner: { name: owner.name } };
};

/** The tools for saved queries: list, get, run, create, update and delete the caller's own and shared ones. */
export const defineSavedQueryTools = (mcp: TereoMcp): void => {
  mcp.define({
    name: "list_saved_queries",
    title: "List saved queries",
    description:
      'List the saved queries you own ("mine", the default), others shared with you ("shared"), or saved queries of others available for dashboards in your organization ("available"). Returns { saved_queries: [{ id, name, description, owner, accessible, source?, query?, last_run_at, you_last_ran_at }], truncated }; truncated is true when only the first 100 are shown. A saved query with accessible false cannot be run by you and carries no query, and no source unless you can read sources.',
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({
      scope: z.enum(["mine", "shared", "available"]).optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const page = await listSavedQueries(caller, {
          scope: input.scope ?? "mine",
          limit: LIST_LIMIT,
        });
        return {
          saved_queries: page.data.map(forModel),
          truncated: page.nextCursor !== null,
        };
      }),
  });

  mcp.define({
    name: "get_saved_query",
    title: "Get a saved query",
    description:
      "Read one saved query by id: its name, description, owner and, when you can run it, its source and query.",
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ id: Id }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return forModel(await getSavedQuery(caller, input.id));
      }),
  });

  mcp.define({
    name: "run_saved_query",
    title: "Run a saved query",
    description:
      "Run a saved query you can see, as the query tool would run its query. limit and offset replace the saved ones. Returns { columns, rows, truncated, truncated_by?, warnings, rows_limited, run_id }.",
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: z.strictObject({
      id: Id,
      ...SavedQueryPagingFields,
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const { body, savedQuery } = await savedQueryToRun(caller, input.id, {
          limit: input.limit,
          offset: input.offset,
        });
        return runQuery({
          caller,
          entryPoint: "mcp",
          body,
          savedQuery,
          signal: ctx.signal,
        });
      }),
  });

  mcp.define({
    name: "create_saved_query",
    title: "Save a query",
    description: `Save a query under a name, for you to run again. Call it only when the user asks to save a query. The query is the same JSON the query tool takes, and is checked against your own access. ${QUERY_LANGUAGE_SUMMARY}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      name: SavedQueryNameSchema.describe("A name, unique among your own"),
      description: SavedQueryDescriptionSchema.optional(),
      query: QueryInput,
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return forModel(
          await createSavedQuery(caller, {
            name: input.name,
            description: input.description ?? "",
            query: input.query,
          })
        );
      }),
  });

  mcp.define({
    name: "update_saved_query",
    title: "Change a saved query",
    description: `Change the name, description or query of a saved query you own. Only what you give changes. ${QUERY_LANGUAGE_SUMMARY}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z.strictObject({
      id: Id,
      name: SavedQueryNameSchema.optional(),
      description: SavedQueryDescriptionSchema.optional(),
      query: QueryInput.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const { id, ...patch } = input;
        return forModel(await updateSavedQuery(caller, id, patch));
      }),
  });

  mcp.define({
    name: "delete_saved_query",
    title: "Delete a saved query",
    description:
      "Delete a saved query you own, for good. Call it only when the user asks.",
    permission: MCP_USE,
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.strictObject({ id: Id }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        // Own saved queries only over MCP: the service also lets a holder of
        // zeteo.saved_queries.write delete another's, which a model must not.
        const row = await db.savedQueries.findById(input.id);
        if (!row || row.ownerId !== caller.userId) {
          throw new NotFoundError("Saved query not found");
        }
        await deleteSavedQuery(caller, input.id);
        return { deleted: true };
      }),
  });
};
