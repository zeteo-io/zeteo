// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { removeDashboardsOf } from "../support/panelDecisions.js";
import { describeEachEngine } from "../support/engines.js";
import { jsonBlocks } from "../support/pure/jsonBlocks.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { QUERY_GUIDE } from "../../mcp/reference.js";
import { tokenFor } from "../support/tokens.js";
import { randomUUID } from "crypto";
import {
  grantTo,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";
import {
  callTool,
  connectMcp,
  mcpToken,
  type McpSession,
} from "../support/mcp.js";

// The examples name an illustrative source, `sales-db`; only the first three
// run here, on the fixture's `orders` and `customers`, with the slug swapped.
describeEachEngine("the query guide", (engine) => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "mcpdoc");
    const principal = { type: "user" as const, id: userId };
    for (const table of ["orders", "customers"]) {
      await grantTo(principal, source.tables[table]!, "all");
    }
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeDashboardsOf([userId]);
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("hold worked examples that each run through the query tool, as over /v1/query", async () => {
    const examples = jsonBlocks(QUERY_GUIDE) as Record<string, unknown>[];
    // The later query examples (calculations) use tables of the examples'
    // schema (order_lines, products) that the fixture lacks; the unit tests in
    // src/tests/mcp/ check they parse. The last block is the add_panel call.
    expect(examples).toHaveLength(7);
    for (const example of examples.slice(0, 3)) {
      expect(example.source).toBe("sales-db");
      const body = { ...example, source: source.slug };
      const call = await callTool(session.client, "query", body);
      expect(call.isError, `${JSON.stringify(example)}: ${call.text}`).toBe(
        false
      );
      expect(call.json.rows.length, JSON.stringify(example)).toBeGreaterThan(0);
      const api = await postQuery(
        tokenFor({ userId, permissions: [DATA_READ] }),
        body
      );
      expect(api.body.rows).toEqual(call.json.rows);
    }
  });

  it("hold an add_panel example that adds its panel once its ids are filled in", async () => {
    const example = (jsonBlocks(QUERY_GUIDE) as Record<string, unknown>[]).find(
      (block) => "dashboard_id" in block
    )!;
    expect(example).toBeDefined();
    const query = await callTool(session.client, "create_saved_query", {
      name: `doc ${randomUUID()}`.slice(0, 60),
      query: {
        source: source.slug,
        from: "orders",
        join: ["customers"],
        select: ["customers.region", { sum: "total", as: "revenue" }],
        groupBy: ["customers.region"],
      },
    });
    expect(query.isError, query.text).toBe(false);
    const dashboard = await callTool(session.client, "create_dashboard", {
      name: `doc ${randomUUID()}`.slice(0, 60),
      time_range: "last_30_days",
    });
    const call = await callTool(session.client, "add_panel", {
      ...example,
      dashboard_id: dashboard.json.id,
      saved_query_id: query.json.id,
    });
    expect(call.isError, call.text).toBe(false);
    expect(call.json).toMatchObject({
      state: "ok",
      title: "Revenue by region",
      time_column: "created_at",
    });
  });
});
