import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { runQuery } from "../engine/index.js";
import { requireDataRead } from "./caller.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";

/** The longest time limit a source may have (120 s), and room for the run's record. */
const QUERY_TOOL_TIMEOUT_MS = 135_000;

// Each clause is declared with its JSON type only, because a model client
// sends an argument the schema does not declare as a string. The engine
// checks the query itself, as for POST /v1/query, so its errors have the same
// paths; for the same reason only `source` is required here.
const QueryInput = z.looseObject({
  source: z.string().describe("The source's slug, as list_sources gives it"),
  from: z
    .string()
    .optional()
    .describe("The table to read, as list_tables names it"),
  join: z
    .array(z.unknown())
    .optional()
    .describe(
      'Relations to join, by name ("customers") or { relation, type: "inner" | "left" }'
    ),
  select: z
    .array(z.unknown())
    .optional()
    .describe(
      'Columns ("id", "customers.region"), aggregates ({ sum: "total", as: "revenue" }; sum, avg, min and max also take an expression, then "as" is required), date buckets and calculations ({ calc: { mul: ["unit_price", "quantity"] }, as: "line_value" })'
    ),
  distinct: z.boolean().optional(),
  where: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'A filter, such as { status: { eq: "paid" } }, combined with and / or'
    ),
  groupBy: z.array(z.unknown()).optional(),
  having: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("A filter on aggregates, by their alias"),
  orderBy: z
    .array(z.unknown())
    .optional()
    .describe('Entries of one { path: "asc" | "desc" }'),
  limit: z.int().optional(),
  offset: z.int().optional(),
});

/** The `query` tool: `POST /v1/query`'s engine, with MCP's row and size limits. */
export const defineQueryTool = (mcp: TereoMcp): void => {
  mcp.define({
    name: "query",
    title: "Query a source",
    description:
      'Run a read-only query on a source, written in its JSON query language: "source", "from", "join", "select" (columns, aggregates, date buckets, and calculations written as { calc, as }), "where", "groupBy", "having", "orderBy", "limit", "offset". Find the source, its tables, columns and relations with list_sources, list_tables and describe_table first. Returns { columns, rows, truncated, truncated_by?, warnings, run_id }.',
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
