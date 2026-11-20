import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { runQuery } from "../engine/index.js";
import { requireDataRead } from "./caller.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";

/** The longest time limit a source may have (120 s), and room for the run's record. */
export const QUERY_TOOL_TIMEOUT_MS = 135_000;

// Each clause is declared with its JSON type only, because a model client
// sends an argument the schema does not declare as a string. The engine
// checks the query itself, as for POST /v1/query, so its errors have the same
// paths; for the same reason only `source` is required here.
export const QueryInput = z.looseObject({
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
  metrics: z
    .array(z.unknown())
    .optional()
    .describe(
      "A metric query instead of from and select: metric and measure names, combined per period"
    ),
  bucket: z
    .string()
    .optional()
    .describe('A metric query\'s period, such as "month"'),
  range: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "A metric query's half-open range on each measure's date column: { gte, lt }"
    ),
});

/**
 * The query language in brief, for the tools that take a query; `query_guide`
 * has the rest.
 */
export const QUERY_LANGUAGE_SUMMARY =
  'A query is one JSON object, no raw SQL: "source" (a slug from list_sources), "from" (a table from list_tables), "join" (relation names from describe_table), "select" (column paths such as "customers.region", aggregates such as { "sum": "total", "as": "revenue" }, date buckets such as { "bucket": "month", "column": "created_at" }, calculations { "calc": expression, "as": name }), "where", "groupBy" (with an aggregate, list every other select item), "having", "orderBy" ([{ "<name>": "asc" | "desc" }]), "limit", "offset", "distinct". Filter operators: eq, ne, gt, gte, lt, lte, between, in, notIn, contains, startsWith, isNull; combine filters with and, or, not. Example: {"source":"sales-db","from":"orders","join":["customers"],"select":["customers.region",{"sum":"total","as":"revenue"}],"where":{"status":{"eq":"paid"}},"groupBy":["customers.region"]}. Call query_guide for the full language: expressions, relative dates, grouping rules, limits and errors.';

/** The `query` tool: `POST /v1/query`'s engine, with MCP's row and size limits. */
export const defineQueryTool = (mcp: TereoMcp): void => {
  mcp.define({
    name: "query",
    title: "Query a source",
    description: `Run a read-only query on a source. Find the source, its tables, columns and relations with list_sources, list_tables and describe_table first. Returns { columns, rows, truncated, truncated_by?, warnings, rows_limited, run_id }. ${QUERY_LANGUAGE_SUMMARY}`,
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
