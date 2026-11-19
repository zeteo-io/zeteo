// @module-tag int
// @module-tag platform
import { measureBody, metricBody, seedMeasures } from "../support/measures.js";
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDashboardsOf } from "../support/panelDecisions.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { BASE_URL } from "../support/http.js";
import { randomUUID } from "crypto";
import {
  grantTo,
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

const postgres = ENGINES.find((e) => e.type === "postgres")!;

// preview_panel over a metric query: time_column "range" replaces its range.
describe("MCP preview_panel over a metric query", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpmetricpanel");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, "all");
    await seedMeasures(
      BASE_URL,
      source,
      [
        {
          ...measureBody("revenue", { sum: "total" }),
          date_column: "created_at",
        },
      ],
      [metricBody("double_revenue", { mul: [{ measure: "revenue" }, 2] })]
    );
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeDashboardsOf([userId]);
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("cuts the metrics to the time range with time_column range, and refuses any other column", async () => {
    const query = {
      source: source.slug,
      metrics: ["double_revenue"],
      bucket: "month",
    };
    const chart = {
      type: "line",
      version: 1,
      x: "period",
      y: ["double_revenue"],
    };
    const whole = await callTool(session.client, "preview_panel", {
      query,
      chart,
    });
    expect(whole.isError, whole.text).toBe(false);
    expect(whole.json).toMatchObject({ row_count: 6, problems: [] });
    // The fixture's orders are January to June 2026.
    const none = await callTool(session.client, "preview_panel", {
      query,
      chart,
      time_column: "range",
      time_range: "previous_month",
    });
    expect(none.isError, none.text).toBe(false);
    expect(none.json).toMatchObject({ row_count: 0, rows: [], problems: [] });
    const wrong = await callTool(session.client, "preview_panel", {
      query,
      chart,
      time_column: "created_at",
      time_range: "previous_month",
    });
    expect(wrong.isError, wrong.text).toBe(false);
    expect(wrong.json).toMatchObject({
      problems: [{ setting: "time_column", problem: "wrong_type" }],
    });
  });

  it("refuses time_column range on a table query", async () => {
    const wrong = await callTool(session.client, "preview_panel", {
      query: {
        source: source.slug,
        from: "orders",
        select: ["id"],
        limit: 5,
      },
      chart: { type: "table", version: 1 },
      time_column: "range",
      time_range: "previous_month",
    });
    expect(wrong.isError, wrong.text).toBe(false);
    expect(wrong.json).toMatchObject({
      problems: [{ setting: "time_column", problem: "wrong_type" }],
    });
  });
});
