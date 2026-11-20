// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { savedQueryOf } from "../support/savedQueries.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { tokenFor } from "../support/tokens.js";
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

// The discovery tools say which tables show the caller only some rows, and
// the query tools' results say when a rule limited what they read.

describe("MCP tools: rows limited", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "mcp-rowrules");
    const principal = { type: "user" as const, id: userId };
    await grantTo(principal, source.tables.orders!, ["id", "total"], {
      access: "rule",
      rule: { status: { eq: "paid" } },
    });
    await grantTo(principal, source.tables.customers!, "all", {
      access: "rule",
      rule: { region: { in: ["EU"] } },
    });
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("list_tables marks each table limited or not", async () => {
    const call = await callTool(session.client, "list_tables", {
      source: source.slug,
    });
    expect(call.isError, call.text).toBe(false);
    const byName = new Map(
      (call.json.tables as Array<{ name: string; rows_limited: boolean }>).map(
        (t) => [t.name, t]
      )
    );
    expect(byName.get("orders")).toMatchObject({
      rows_limited: true,
      rows_limited_reason: "some rows only",
    });
    expect(byName.get("customers")).toMatchObject({
      rows_limited: true,
      rows_limited_reason: "region is one of EU",
    });
  });

  it("describe_table gives the reason, naming only granted columns", async () => {
    const orders = await callTool(session.client, "describe_table", {
      source: source.slug,
      table: "orders",
    });
    expect(orders.isError, orders.text).toBe(false);
    expect(orders.json.table).toMatchObject({
      rows_limited: true,
      rows_limited_reason: "some rows only",
    });
    expect(orders.text).not.toContain("status");
  });

  it("query and run_saved_query carry rows_limited", async () => {
    const query = await callTool(session.client, "query", {
      source: source.slug,
      from: "orders",
      select: ["id"],
    });
    expect(query.isError, query.text).toBe(false);
    expect(query.json.rows_limited).toBe(true);

    const savedId = await savedQueryOf(
      tokenFor({ userId, permissions: [DATA_READ] }),
      source,
      { query: { source: source.slug, from: "orders", select: ["id"] } }
    );
    const run = await callTool(session.client, "run_saved_query", {
      id: savedId,
    });
    expect(run.isError, run.text).toBe(false);
    expect(run.json.rows_limited).toBe(true);
  });

  it("preview_panel and card_panel_rows carry rows_limited", async () => {
    const args = {
      query: { source: source.slug, from: "orders", select: ["id", "total"] },
      chart: { type: "table", version: 1 },
    };
    for (const tool of ["preview_panel", "card_panel_rows"]) {
      const call = await callTool(session.client, tool, args);
      expect(call.isError, call.text).toBe(false);
      expect(call.json.rows_limited, tool).toBe(true);
    }
  });
});
