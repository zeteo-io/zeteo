// @module-tag int
// @module-tag platform
// @module-tag slow
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { randomUUID } from "crypto";
import {
  grantTo,
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

describeEachEngine("MCP query tool: limits", (engine) => {
  /** Over the portable tables and the probe schema's 60,000 wide rows. */
  let wide: SeededSource;
  /** A time limit of one second. */
  let quick: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    wide = await seedQuerySource(
      engine,
      { schemas: [...engine.schemas, "probe"] },
      "mcpwide"
    );
    quick = await seedQuerySource(engine, { timeout_ms: 1000 }, "mcpquick");
    const principal = { type: "user" as const, id: userId };
    await grantTo(principal, wide.tables.wide_rows!, "all");
    await grantTo(principal, quick.tables.slow_orders!, "all");
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([userId]);
    await removeSources([wide.id, quick.id]);
  });

  const ids = (n: number) => Array.from({ length: n }, (_, i) => [i + 1]);

  it("returns 100 rows by default, and says more existed", async () => {
    const call = await callTool(session.client, "query", {
      source: wide.slug,
      from: "wide_rows",
      select: ["id"],
    });
    expect(call.isError).toBe(false);
    expect(call.json.rows).toEqual(ids(100));
    expect(call.json.truncated).toBe(true);
    expect(call.json.truncated_by).toBe("rows");
  });

  it("returns at most 5,000 rows, whatever the limit asks", async () => {
    const call = await callTool(session.client, "query", {
      source: wide.slug,
      from: "wide_rows",
      select: ["id"],
      limit: 50_000,
    });
    expect(call.isError).toBe(false);
    expect(call.json.rows).toEqual(ids(5000));
    expect(call.json.truncated_by).toBe("rows");
  });

  it("stops at 1 MB of rows with truncated_by bytes", async () => {
    const call = await callTool(session.client, "query", {
      source: wide.slug,
      from: "wide_rows",
      select: ["id", "filler"],
      limit: 5000,
    });
    expect(call.isError).toBe(false);
    expect(call.json.truncated).toBe(true);
    expect(call.json.truncated_by).toBe("bytes");
    const rows = call.json.rows as [number, string][];
    // 2 KB rows: about 500 fit 1 MB.
    expect(rows.length).toBeGreaterThan(400);
    expect(rows.length).toBeLessThan(600);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(
      1024 * 1024
    );
  });

  it("answers a query past the source's time limit with the tool error query_timeout", async () => {
    const started = Date.now();
    const call = await callTool(session.client, "query", {
      source: quick.slug,
      from: "slow_orders",
      select: ["id"],
    });
    expect(Date.now() - started).toBeLessThan(2900);
    expect(call.isError).toBe(true);
    expect(call.json).toEqual({
      error: "query_timeout",
      error_description: "The query ran past its time limit",
      request_id: expect.any(String),
    });
    expect(await engine.runningOn("slow_orders")).toBe(0);
    expect((await runsOf([userId])).at(-1)).toMatchObject({
      entryPoint: "mcp",
      outcome: "timeout",
    });
  });
});
