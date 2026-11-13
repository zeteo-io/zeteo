// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { MCP_INSTRUCTIONS } from "../../mcp/instructions.js";
import { describeEachEngine } from "../support/engines.js";
import { jsonBlocks } from "../support/pure/jsonBlocks.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
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

// The examples name an illustrative source, `sales-db`, whose `orders` and
// `customers` have the fixture's names; only the slug is swapped to run them.
describeEachEngine("MCP_INSTRUCTIONS", (engine) => {
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
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("are sent to the client at initialize", () => {
    expect(session.client.getInstructions()).toBe(MCP_INSTRUCTIONS);
  });

  it("hold worked examples that each run through the query tool, as over /v1/query", async () => {
    const examples = jsonBlocks(MCP_INSTRUCTIONS) as Record<string, unknown>[];
    expect(examples).toHaveLength(3);
    for (const example of examples) {
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
});
