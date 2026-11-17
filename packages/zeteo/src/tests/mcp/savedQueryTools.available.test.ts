// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { callTool, connectMcp, type McpSession } from "../support/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { TEST_MCP_CLIENT } from "../setup/testEnv.js";
import { tokenFor } from "../support/tokens.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
import {
  savedQueriesCall,
  savedQueryOf,
  userWithOrders,
} from "../support/savedQueries.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

describe("MCP list_saved_queries scope available", () => {
  let source: SeededSource;
  let session: McpSession;
  const org = randomUUID();
  const ids: string[] = [];

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "mcpavail");
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf(ids);
    await removeSources([source.id]);
  });

  it("lists another user's available saved query", async () => {
    const owner = await userWithOrders(source);
    const viewer = await userWithOrders(source);
    ids.push(owner.id, viewer.id);
    const ownerToken = tokenFor({
      userId: owner.id,
      permissions: [DATA_READ],
      org,
    });
    const id = await savedQueryOf(ownerToken, source);
    await savedQueriesCall("PATCH", `/${id}`, ownerToken, {
      available_for_dashboards: true,
    });
    session = await connectMcp(
      tokenFor({
        userId: viewer.id,
        permissions: [MCP_USE, DATA_READ],
        org,
        client: TEST_MCP_CLIENT,
      })
    );
    const res = await callTool(session.client, "list_saved_queries", {
      scope: "available",
    });
    expect(res.isError, res.text).toBe(false);
    const listed = JSON.parse(res.text).saved_queries as Array<{ id: string }>;
    expect(listed.some((s) => s.id === id)).toBe(true);
  });
});
