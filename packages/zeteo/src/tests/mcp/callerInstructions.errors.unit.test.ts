// @module-tag unit
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_INSTRUCTIONS } from "../../mcp/instructions.js";
import type { InstructionsContext } from "@tereo-io/mcp";
import { logger } from "../../utils/logger.js";
import {
  callerInstructions,
  instructionsWith,
  sourcesSection,
} from "../../mcp/callerInstructions.js";

const stubs = vi.hoisted(() => ({
  readCachedInstructions: vi.fn(),
  cacheInstructions: vi.fn(),
  loadAccess: vi.fn(),
  listVisibleSources: vi.fn(),
}));
vi.mock("../../utils/redis.js", () => ({ redis: {} }));
vi.mock("../../mcp/redis.js", () => ({
  readCachedInstructions: stubs.readCachedInstructions,
  cacheInstructions: stubs.cacheInstructions,
}));
vi.mock("../../grants/access.js", () => ({ loadAccess: stubs.loadAccess }));
vi.mock("../../mcp/visibleSources.js", () => ({
  listVisibleSources: stubs.listVisibleSources,
}));

const ctx = {
  auth: {
    userId: "user-1",
    organizationId: "org-1",
    permissions: [MCP_USE, DATA_READ],
    userType: "user",
  },
  requestId: "req-1",
} as unknown as InstructionsContext;

const view = {
  slug: "sales-db",
  name: "Sales",
  type: "postgres",
  description: "Orders and customers",
  tables: [{}, {}],
};

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("callerInstructions", () => {
  it("sends MCP_INSTRUCTIONS when the build has not settled within 1.5 s", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    stubs.readCachedInstructions.mockResolvedValue(null);
    // A build that never settles.
    stubs.loadAccess.mockReturnValue(new Promise(() => {}));
    const sent = callerInstructions(ctx);
    let settled = false;
    void sent.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(sent).resolves.toBe(MCP_INSTRUCTIONS);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: "req-1" }),
      "MCP instructions fell back to the static text"
    );
  });

  it("sends the built text when caching it fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    stubs.readCachedInstructions.mockResolvedValue(null);
    stubs.loadAccess.mockResolvedValue({});
    stubs.listVisibleSources.mockResolvedValue([view]);
    stubs.cacheInstructions.mockRejectedValue(new Error("Redis is down"));
    const text = await callerInstructions(ctx);
    expect(text).toBe(
      instructionsWith(
        sourcesSection([
          {
            slug: "sales-db",
            name: "Sales",
            type: "postgres",
            description: "Orders and customers",
            tables: 2,
          },
        ])
      )
    );
    expect(stubs.cacheInstructions).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      text
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: "req-1" }),
      "MCP instructions not cached"
    );
  });
});
