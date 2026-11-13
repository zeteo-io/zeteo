// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { createTestClient, startStubCore } from "@tereo-io/mcp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, mcpToken } from "../support/mcp.js";
import { Redis } from "ioredis";
import {
  startSilentServer,
  type SilentServer,
} from "../support/silentServer.js";

describe("rateLimitRedis", () => {
  let silent: SilentServer;
  let stuck: Redis;
  let stubCore: Awaited<ReturnType<typeof startStubCore>>;
  let stopTereo: () => Promise<void>;

  beforeAll(async () => {
    silent = await startSilentServer();
    // Connects, then never answers: every command waits forever.
    stuck = new Redis(silent.port, "127.0.0.1", {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    stuck.on("error", () => undefined);
    void stuck.connect().catch(() => undefined);
    stubCore = await startStubCore();
    const tereo = await import("../../utils/tereo.js");
    await tereo.initializeTereo();
    stopTereo = tereo.stopTereo;
  });
  afterAll(async () => {
    stuck.disconnect();
    await silent.close();
    await stubCore.close();
    await stopTereo();
  });

  it("does not hold a tool call on a Redis that never answers", async () => {
    const { createZeteoMcp } = await import("../../mcp/index.js");
    const { rateLimitRedis } = await import("../../mcp/redis.js");
    const mcp = createZeteoMcp({
      coreUrl: stubCore.coreUrl,
      redis: rateLimitRedis(stuck),
    });
    const { client, close } = await createTestClient(mcp, {
      token: mcpToken([MCP_USE, DATA_READ]),
    });
    try {
      const started = Date.now();
      const call = await callTool(client, "list_sources");
      expect(Date.now() - started).toBeLessThan(3000);
      expect(call.isError).toBe(false);
      expect(call.json).toEqual({ sources: [] });
    } finally {
      await close();
    }
  });
});
