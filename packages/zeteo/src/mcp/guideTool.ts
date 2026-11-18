import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { TereoMcp } from "@tereo-io/mcp";
import { QUERY_GUIDE } from "./reference.js";

/**
 * The `query_guide` tool: the full query language and dashboard reference,
 * which the server instructions leave out to stay short. It reads no data, so
 * it needs only `zeteo.mcp.use`.
 */
export const defineGuideTool = (mcp: TereoMcp): void => {
  mcp.define({
    name: "query_guide",
    title: "Query guide",
    description:
      "The full reference for writing queries and dashboards: the JSON query language (joins, aggregates, date buckets, calculations, filters and relative dates, grouping) with worked examples, results, limits, errors, saved queries, chart settings, time_column and panel placement. Call it before you write your first query or chart. Returns { guide } (Markdown).",
    permission: MCP_USE,
    readOnly: true,
    handler: async () => ({ guide: QUERY_GUIDE }),
  });
};
