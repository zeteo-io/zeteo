import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { runQuery } from "../engine/index.js";
import { requireDataRead } from "./caller.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";

/** The longest time limit a source may have (120 s), and room for the run's record. */
const QUERY_TOOL_TIMEOUT_MS = 135_000;

// The rest of the query is the source's language, checked by the engine as
// for POST /v1/query, so its errors have the same paths.
const QueryInput = z.looseObject({
  source: z.string().describe("The source's slug, as list_sources gives it"),
});

/** The `query` tool: `POST /v1/query`'s engine, with MCP's row and size limits. */
export const defineQueryTool = (mcp: TereoMcp): void => {
  mcp.define({
    name: "query",
    title: "Query a source",
    description:
      'Run a read-only query on a source, written in its JSON query language: "source", "from", "join", "select" (columns, aggregates, date buckets), "where", "groupBy", "having", "orderBy", "limit", "offset". Find the source, its tables, columns and relations with list_sources, list_tables and describe_table first. Returns { columns, rows, truncated, truncated_by?, warnings, run_id }.',
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: QueryInput,
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        return runQuery({
          caller,
          entryPoint: "mcp",
          body: input,
          signal: ctx.signal,
        });
      }),
  });
};
