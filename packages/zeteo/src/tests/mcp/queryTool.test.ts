// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { tokenFor } from "../support/tokens.js";
import { randomUUID } from "crypto";
import {
  grantTo,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";
import {
  callTool,
  connectMcp,
  mcpToken,
  type McpSession,
} from "../support/mcp.js";

describeEachEngine("MCP query tool", (engine) => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();
  const users = [userId];

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "mcpquery");
    const principal = { type: "user" as const, id: userId };
    await grantTo(principal, source.tables.orders!, "all");
    await grantTo(principal, source.tables.customers!, "all");
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  const query = (body: Record<string, unknown>) =>
    callTool(session.client, "query", { source: source.slug, ...body });

  it("is listed read-only, with a description naming the clauses and the discovery tools", async () => {
    const { tools } = await session.client.listTools();
    const tool = tools.find((t) => t.name === "query");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    for (const word of [
      "from",
      "join",
      "select",
      "where",
      "groupBy",
      "having",
      "orderBy",
      "limit",
      "list_sources",
      "list_tables",
      "describe_table",
    ]) {
      expect(tool?.description).toContain(word);
    }
  });

  it("returns the rows POST /v1/query returns, recorded with entry point mcp", async () => {
    const body = {
      source: source.slug,
      from: "orders",
      join: ["customer"],
      select: ["id", "customer.region", "total"],
      where: { status: { eq: "paid" } },
      orderBy: [{ id: "asc" }],
    };
    const call = await callTool(session.client, "query", body);
    expect(call.isError).toBe(false);
    const api = await postQuery(
      tokenFor({ userId, permissions: [DATA_READ] }),
      body
    );
    expect(api.status).toBe(200);
    const { run_id: mcpRun, ...mcpResult } = call.json;
    const { run_id: apiRun, ...apiResult } = api.body;
    expect(mcpResult).toEqual(apiResult);
    expect(mcpResult.rows.length).toBeGreaterThan(3);

    const runs = await runsOf([userId]);
    expect(runs.find((r) => r.id === mcpRun)).toMatchObject({
      entryPoint: "mcp",
      outcome: "ok",
      sourceId: source.id,
      rowCount: mcpResult.rows.length,
    });
    expect(runs.find((r) => r.id === apiRun)?.entryPoint).toBe("api");
  });

  it("answers a name it cannot plan with the error's path and suggestions", async () => {
    const call = await query({ from: "orders", select: ["id", "statu"] });
    expect(call.isError).toBe(true);
    expect(call.json).toEqual({
      error: "not_found_or_not_accessible",
      error_description: 'Column "statu" was not found or is not accessible',
      path: ["select", 1],
      suggestions: ["status"],
      request_id: expect.any(String),
    });
  });

  it("answers a body the language refuses with invalid_request and its issues", async () => {
    const call = await query({ from: "orders", select: ["id"], bogus: 1 });
    expect(call.isError).toBe(true);
    expect(call.json).toMatchObject({
      error: "invalid_request",
      issues: expect.any(Array),
      request_id: expect.any(String),
    });
  });

  it("refuses a caller without zeteo.data.read before running anything", async () => {
    const other = randomUUID();
    users.push(other);
    const without = await connectMcp(mcpToken([MCP_USE], other));
    try {
      const call = await callTool(without.client, "query", {
        source: source.slug,
        from: "orders",
        select: ["id"],
      });
      expect(call.json).toEqual({
        error: "forbidden",
        error_description: "Requires the zeteo.data.read permission",
        request_id: expect.any(String),
      });
      expect(await runsOf([other])).toEqual([]);
    } finally {
      await without.close();
    }
  });
});
