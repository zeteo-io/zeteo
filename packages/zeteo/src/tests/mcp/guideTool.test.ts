// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { callTool, connectMcp, mcpToken } from "../support/mcp.js";
import { QUERY_GUIDE } from "../../mcp/reference.js";
import { describe, expect, it } from "vitest";

describe("MCP query_guide tool", () => {
  it("returns the full query and dashboard reference, read-only", async () => {
    const session = await connectMcp(mcpToken([MCP_USE]));
    try {
      const { tools } = await session.client.listTools();
      const tool = tools.find((t) => t.name === "query_guide");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      const call = await callTool(session.client, "query_guide");
      expect(call.isError).toBe(false);
      expect(call.json).toEqual({ guide: QUERY_GUIDE });
    } finally {
      await session.close();
    }
  });

  it("is not listed without zeteo.mcp.use", async () => {
    const session = await connectMcp(mcpToken([DATA_READ]));
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("query_guide");
    } finally {
      await session.close();
    }
  });
});
