// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { createTestClient, startStubCore } from "@tereo-io/mcp/testing";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { callTool, connectMcp, mcpToken } from "../support/mcp.js";
import type { SourceConnection } from "../../adapters/types.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { removeSources } from "../support/sources.js";
import { randomUUID } from "crypto";
import {
  grantTo,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// A failure that is not one of zeteo's errors, raised where a driver's would
// be, when a test asks for it. The MCP server below runs in this process.
const fault = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock(import("../../sources/pools.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withSourceConnection: <T>(
      id: string,
      fn: (conn: SourceConnection) => Promise<T>
    ) => {
      if (fault.error) return Promise.reject(fault.error);
      return actual.withSourceConnection(id, fn);
    },
  };
});

const waitFor = async <T>(
  check: () => Promise<T | undefined>,
  ms = 5000
): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error("never seen");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describeEachEngine("MCP query tool: errors", (engine) => {
  let source: SeededSource;
  let stubCore: Awaited<ReturnType<typeof startStubCore>>;
  let stopTereo: () => Promise<void>;
  let mcp: Awaited<ReturnType<typeof createTestClient>>;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "mcperr");
    const principal = { type: "user" as const, id: userId };
    await grantTo(principal, source.tables.orders!, "all");
    await grantTo(principal, source.tables.slow_orders!, "all");
    stubCore = await startStubCore();
    const tereo = await import("../../utils/tereo.js");
    await tereo.initializeTereo();
    stopTereo = tereo.stopTereo;
    const { createZeteoMcp } = await import("../../mcp/index.js");
    mcp = await createTestClient(
      createZeteoMcp({ coreUrl: stubCore.coreUrl }),
      { token: mcpToken([MCP_USE, DATA_READ], userId) }
    );
  });
  afterEach(() => {
    fault.error = undefined;
  });
  afterAll(async () => {
    await mcp?.close();
    await closeAllSourcePools();
    await stubCore.close();
    await stopTereo();
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("answers a failure that is not zeteo's own as an internal error naming the request, and nothing else", async () => {
    fault.error = new Error(
      'relation "sales.secret_payroll" does not exist at character 42'
    );
    const call = await callTool(mcp.client, "query", {
      source: source.slug,
      from: "orders",
      select: ["id"],
    });
    expect(call.isError).toBe(true);
    expect(call.text).toMatch(/^Internal error \(request [0-9a-f-]{36}\)$/);
    expect(call.text).not.toMatch(/secret_payroll|relation|character/);
  });

  // The client's transport closes the call's HTTP request. A
  // notifications/cancelled alone arrives on a request of its own, which the
  // package's per-request server cannot tie to the call.
  it("stops the statement on the source when the client goes away mid-call, recorded as client_closed", async () => {
    // On the shared server: closing it here does not stop this file's server.
    const own = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
    const sent = callTool(own.client, "query", {
      source: source.slug,
      from: "slow_orders",
      select: ["id"],
    }).catch((err: unknown) => err);
    await waitFor(async () =>
      (await engine.runningOn("slow_orders")) > 0 ? true : undefined
    );
    const cancelled = Date.now();
    await own.close();
    expect(await sent).toBeInstanceOf(Error);

    const run = await waitFor(async () =>
      (await runsOf([userId])).find((r) => r.errorCode === "client_closed")
    );
    expect(run).toMatchObject({ entryPoint: "mcp", outcome: "failed" });
    // slow_orders takes three seconds: it was stopped, not left to finish.
    expect(Date.now() - cancelled).toBeLessThan(2500);
    expect(await engine.runningOn("slow_orders")).toBe(0);
  });
});
