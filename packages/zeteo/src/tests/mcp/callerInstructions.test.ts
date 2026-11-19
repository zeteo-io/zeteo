// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { createTestClient, startStubCore } from "@tereo-io/mcp/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedMeasures, measureBody } from "../support/measures.js";
import { grantTo, seedQuerySource } from "../support/queries.js";
import { MCP_INSTRUCTIONS } from "../../mcp/instructions.js";
import { connectMcp, mcpToken } from "../support/mcp.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { BASE_URL } from "../support/http.js";
import { redis } from "../../utils/redis.js";
import { randomUUID } from "crypto";

const postgres = ENGINES.find((e) => e.type === "postgres")!;

const instructionsOf = async (token: string): Promise<string | undefined> => {
  const session = await connectMcp(token);
  try {
    return session.client.getInstructions();
  } finally {
    await session.close();
  }
};

describe("per-caller MCP instructions", () => {
  const userId = randomUUID();
  const token = mcpToken([MCP_USE, DATA_READ], userId);
  const cacheKey = `zeteo:mcp:instructions:${userId}`;
  const sourceIds: string[] = [];
  let granted: Awaited<ReturnType<typeof seedQuerySource>>;
  let later: Awaited<ReturnType<typeof seedQuerySource>>;

  beforeAll(async () => {
    granted = await seedQuerySource(
      postgres,
      { description: "Orders and customers of the web shop" },
      "mcp-instr-granted"
    );
    later = await seedQuerySource(
      postgres,
      { description: "Stock levels per warehouse" },
      "mcp-instr-later"
    );
    sourceIds.push(granted.id, later.id);
    await grantTo({ type: "user", id: userId }, granted.tables.orders!, "all");
    await seedMeasures(BASE_URL, granted, [
      measureBody("total_revenue", { sum: "total" }),
      measureBody(
        "paid_revenue",
        { measure: "total_revenue" },
        { status: { eq: "paid" } }
      ),
    ]);
  });
  afterAll(async () => {
    await redis.del(cacheKey);
    await removeSources(sourceIds);
  });

  it("list the caller's granted source, not an ungranted one, and cache the list for 5 minutes", async () => {
    const text = await instructionsOf(token);
    expect(text).toContain("## What you can query");
    expect(text).toContain(`\`${granted.slug}\``);
    expect(text).toContain("Orders and customers of the web shop");
    expect(text).not.toContain(later.slug);
    const ttl = await redis.ttl(cacheKey);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("count the source's measures the caller may use on its line, and name none", async () => {
    await redis.del(cacheKey);
    const text = (await instructionsOf(token))!;
    const line = text
      .split("\n")
      .find((l) => l.includes(`\`${granted.slug}\``))!;
    expect(line).toContain(", 2 measures)");
    expect(text).not.toContain("paid_revenue");
    expect(text).not.toContain("total_revenue");
  });

  it("keep the cached list on a second connect after a new grant, and show it once the key is gone", async () => {
    await instructionsOf(token);
    await grantTo({ type: "user", id: userId }, later.tables.orders!, "all");
    const cached = await instructionsOf(token);
    expect(cached).not.toContain(later.slug);

    await redis.del(cacheKey);
    const fresh = await instructionsOf(token);
    expect(fresh).toContain(`\`${later.slug}\``);
    expect(fresh).toContain("Stock levels per warehouse");
  });

  it("say nothing is granted to a caller with no grant", async () => {
    const text = await instructionsOf(mcpToken([MCP_USE, DATA_READ]));
    expect(text).toContain(
      "Nothing is granted to you yet; ask an admin for access."
    );
  });
});

describe("per-caller MCP instructions for two users on one server", () => {
  const first = randomUUID();
  const second = randomUUID();
  const sourceIds: string[] = [];
  let firstSource: Awaited<ReturnType<typeof seedQuerySource>>;
  let secondSource: Awaited<ReturnType<typeof seedQuerySource>>;

  beforeAll(async () => {
    firstSource = await seedQuerySource(
      postgres,
      { description: "The first user's ledger" },
      "mcp-instr-first"
    );
    secondSource = await seedQuerySource(
      postgres,
      { description: "The second user's ledger" },
      "mcp-instr-second"
    );
    sourceIds.push(firstSource.id, secondSource.id);
    await grantTo(
      { type: "user", id: first },
      firstSource.tables.orders!,
      "all"
    );
    await grantTo(
      { type: "user", id: second },
      secondSource.tables.orders!,
      "all"
    );
  });
  afterAll(async () => {
    await redis.del(
      `zeteo:mcp:instructions:${first}`,
      `zeteo:mcp:instructions:${second}`
    );
    await removeSources(sourceIds);
  });

  it("give each user only their own sources, the second connecting after the first is cached", async () => {
    const firstText = await instructionsOf(
      mcpToken([MCP_USE, DATA_READ], first)
    );
    expect(firstText).toContain(`\`${firstSource.slug}\``);
    expect(firstText).not.toContain(secondSource.slug);
    expect(await redis.get(`zeteo:mcp:instructions:${first}`)).toBe(firstText);

    const secondText = await instructionsOf(
      mcpToken([MCP_USE, DATA_READ], second)
    );
    expect(secondText).toContain(`\`${secondSource.slug}\``);
    expect(secondText).toContain("The second user's ledger");
    expect(secondText).not.toContain(firstSource.slug);
    expect(secondText).not.toContain("The first user's ledger");
  });
});

describe("per-caller MCP instructions when Redis fails", () => {
  let stubCore: Awaited<ReturnType<typeof startStubCore>>;
  let stopTereo: () => Promise<void>;

  beforeAll(async () => {
    stubCore = await startStubCore();
    const tereo = await import("../../utils/tereo.js");
    await tereo.initializeTereo();
    stopTereo = tereo.stopTereo;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await stubCore.close();
    await stopTereo();
  });

  it("are MCP_INSTRUCTIONS when the cache read throws", async () => {
    const { createZeteoMcp } = await import("../../mcp/index.js");
    vi.spyOn(redis, "get").mockRejectedValue(new Error("Redis is down"));
    const mcp = createZeteoMcp({ coreUrl: stubCore.coreUrl });
    const { client, close } = await createTestClient(mcp, {
      token: mcpToken([MCP_USE, DATA_READ]),
    });
    try {
      expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    } finally {
      await close();
    }
  });
});
