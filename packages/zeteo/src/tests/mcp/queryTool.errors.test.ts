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
  /** A time limit of one second. */
  let quick: SeededSource;
  let stubCore: Awaited<ReturnType<typeof startStubCore>>;
  let stopTereo: () => Promise<void>;
  let mcp: Awaited<ReturnType<typeof createTestClient>>;
  const userId = randomUUID();
  const users = [userId];

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "mcperr");
    quick = await seedQuerySource(engine, { timeout_ms: 1000 }, "mcperrq");
    const principal = { type: "user" as const, id: userId };
    await grantTo(principal, source.tables.orders!, "all");
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
    await removeRunsOf(users);
    await removeSources([source.id, quick.id]);
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

  /** A user granted slow_orders (three seconds a run) on `on`. */
  const slowUser = async (on: SeededSource) => {
    const id = randomUUID();
    users.push(id);
    await grantTo({ type: "user", id }, on.tables.slow_orders!, "all");
    return id;
  };

  const slowQuery = (on: SeededSource) => ({
    source: on.slug,
    from: "slow_orders",
    select: ["id"],
  });

  /** The user's one run, once it is recorded. */
  const runOf = (id: string) => waitFor(async () => (await runsOf([id]))[0]);

  // On the shared server, so closing a client here leaves this file's server
  // running.
  it("stops the statement on the source when a client cancels the call on a 2026-era connection, recorded as client_closed", async () => {
    const id = await slowUser(source);
    const session = await connectMcp(
      mcpToken([MCP_USE, DATA_READ], id),
      undefined,
      "modern"
    );
    try {
      expect(session.client.getProtocolEra()).toBe("modern");
      const controller = new AbortController();
      const sent = session.client
        .callTool(
          { name: "query", arguments: slowQuery(source) },
          { signal: controller.signal }
        )
        .catch((err: unknown) => err);
      await waitFor(async () =>
        (await engine.runningOn("slow_orders")) > 0 ? true : undefined
      );
      const cancelled = Date.now();
      controller.abort();
      expect(await sent).toBeInstanceOf(Error);

      const run = await runOf(id);
      expect(run).toMatchObject({
        entryPoint: "mcp",
        outcome: "failed",
        errorCode: "client_closed",
      });
      // slow_orders takes three seconds: it was stopped, not left to finish.
      expect(Date.now() - cancelled).toBeLessThan(2500);
      expect(await engine.runningOn("slow_orders")).toBe(0);
    } finally {
      await session.close();
    }
  });

  // A 2025-era cancel is a notifications/cancelled POST of its own, which the
  // package's per-request server cannot tie to the running call. This pins
  // that limitation; it is not the behaviour wanted. The source's one-second
  // time limit bounds the statement.
  it("KNOWN LIMITATION: a cancel on a 2025-era (legacy) connection does not stop the statement", async () => {
    const id = await slowUser(quick);
    const session = await connectMcp(mcpToken([MCP_USE, DATA_READ], id));
    try {
      expect(session.client.getProtocolEra()).toBe("legacy");
      const controller = new AbortController();
      const sent = session.client
        .callTool(
          { name: "query", arguments: slowQuery(quick) },
          { signal: controller.signal }
        )
        .catch((err: unknown) => err);
      await waitFor(async () =>
        (await engine.runningOn("slow_orders")) > 0 ? true : undefined
      );
      controller.abort();
      expect(await sent).toBeInstanceOf(Error);

      // It ran on to its time limit, never seen as cancelled.
      expect(await runOf(id)).toMatchObject({
        entryPoint: "mcp",
        outcome: "timeout",
        errorCode: "query_timeout",
      });
    } finally {
      await session.close();
    }
  });

  it("stops the statement on the source when the client goes away mid-call, recorded as client_closed", async () => {
    const id = await slowUser(source);
    const own = await connectMcp(mcpToken([MCP_USE, DATA_READ], id));
    const sent = callTool(own.client, "query", slowQuery(source)).catch(
      (err: unknown) => err
    );
    await waitFor(async () =>
      (await engine.runningOn("slow_orders")) > 0 ? true : undefined
    );
    const cancelled = Date.now();
    await own.close();
    expect(await sent).toBeInstanceOf(Error);

    expect(await runOf(id)).toMatchObject({
      entryPoint: "mcp",
      outcome: "failed",
      errorCode: "client_closed",
    });
    expect(Date.now() - cancelled).toBeLessThan(2500);
    expect(await engine.runningOn("slow_orders")).toBe(0);
  });
});
