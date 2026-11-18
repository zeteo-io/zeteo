// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { MCP_INSTRUCTIONS } from "../../mcp/instructions.js";
import { connectMcp, mcpToken } from "../support/mcp.js";
import { describe, expect, it } from "vitest";

describe("MCP server instructions", () => {
  it("are sent at initialize as MCP_INSTRUCTIONS", async () => {
    const session = await connectMcp(mcpToken([MCP_USE, DATA_READ]));
    try {
      expect(session.client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    } finally {
      await session.close();
    }
  });
});
