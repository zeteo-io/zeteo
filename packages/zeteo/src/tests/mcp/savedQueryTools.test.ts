// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { tokenFor } from "../support/tokens.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MCP_USE,
  SAVED_QUERIES_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  ordersQuery,
  savedQueryOf,
  uniqueName,
} from "../support/savedQueries.js";
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

const postgres = ENGINES.find((e) => e.type === "postgres")!;

describe("MCP saved query tools", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpsaved");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, [
      "id",
      "status",
    ]);
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("creates a saved query, which then appears in list_saved_queries without owner.id", async () => {
    const name = uniqueName("mcp");
    const created = await callTool(session.client, "create_saved_query", {
      name,
      description: "paid orders",
      query: ordersQuery(source),
    });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({
      name,
      description: "paid orders",
      accessible: true,
      query: ordersQuery(source),
      source: { slug: source.slug },
    });
    expect(created.json.owner).not.toHaveProperty("id");

    const listed = await callTool(session.client, "list_saved_queries");
    expect(listed.isError).toBe(false);
    expect(
      listed.json.saved_queries.map((s: { id: string }) => s.id)
    ).toContain(created.json.id);
    for (const view of listed.json.saved_queries) {
      expect(view.owner).not.toHaveProperty("id");
    }

    const got = await callTool(session.client, "get_saved_query", {
      id: created.json.id,
    });
    expect(got.json).toEqual(created.json);
  });

  it("updates and deletes a saved query", async () => {
    const created = await callTool(session.client, "create_saved_query", {
      name: uniqueName("upd"),
      query: ordersQuery(source),
    });
    const renamed = uniqueName("renamed");
    const updated = await callTool(session.client, "update_saved_query", {
      id: created.json.id,
      name: renamed,
      query: ordersQuery(source, ["id"]),
    });
    expect(updated.isError, updated.text).toBe(false);
    expect(updated.json).toMatchObject({
      name: renamed,
      query: ordersQuery(source, ["id"]),
    });
    const deleted = await callTool(session.client, "delete_saved_query", {
      id: created.json.id,
    });
    expect(deleted.isError, deleted.text).toBe(false);
    const gone = await callTool(session.client, "get_saved_query", {
      id: created.json.id,
    });
    expect(gone.isError).toBe(true);
    expect(gone.json.error).toBe("not_found");
  });

  it("run_saved_query returns rows and stamps you_last_ran_at", async () => {
    const created = await callTool(session.client, "create_saved_query", {
      name: uniqueName("run"),
      query: ordersQuery(source),
    });
    expect(created.json.you_last_ran_at).toBeNull();
    const run = await callTool(session.client, "run_saved_query", {
      id: created.json.id,
      limit: 2,
    });
    expect(run.isError, run.text).toBe(false);
    expect(run.json.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "status",
    ]);
    expect(run.json.rows).toHaveLength(2);
    expect(run.json.run_id).toEqual(expect.any(String));
    const got = await callTool(session.client, "get_saved_query", {
      id: created.json.id,
    });
    expect(got.json.you_last_ran_at).toEqual(expect.any(String));
  });

  it("run_saved_query refuses an offset past the language's bound as invalid arguments, recording nothing", async () => {
    const created = await callTool(session.client, "create_saved_query", {
      name: uniqueName("offset"),
      query: ordersQuery(source),
    });
    const before = (await runsOf([userId])).length;
    const run = await callTool(session.client, "run_saved_query", {
      id: created.json.id,
      offset: 1_000_001,
    });
    expect(run.isError).toBe(true);
    // The tool's input schema refuses it before the handler: an invalid
    // arguments error, never saved_query_not_accessible.
    expect(run.text).toMatch(/Invalid arguments.*offset.*1000000/);
    expect(run.text).not.toContain("saved_query_not_accessible");
    expect(await runsOf([userId])).toHaveLength(before);
  });

  it("does not let a zeteo.saved_queries.write holder delete another user's saved query", async () => {
    const created = await callTool(session.client, "create_saved_query", {
      name: uniqueName("keep"),
      query: ordersQuery(source),
    });
    const admin = await connectMcp(
      mcpToken([MCP_USE, DATA_READ, SAVED_QUERIES_WRITE], randomUUID())
    );
    try {
      const refused = await callTool(admin.client, "delete_saved_query", {
        id: created.json.id,
      });
      expect(refused.isError).toBe(true);
      expect(refused.json.error).toBe("not_found");
      const missing = await callTool(admin.client, "delete_saved_query", {
        id: randomUUID(),
      });
      expect(missing.json.error).toBe("not_found");
      expect(missing.json.error_description).toBe(
        refused.json.error_description
      );
    } finally {
      await admin.close();
    }
    const still = await callTool(session.client, "get_saved_query", {
      id: created.json.id,
    });
    expect(still.isError).toBe(false);
  });

  it("scope shared lists only what others shared", async () => {
    const listed = await callTool(session.client, "list_saved_queries", {
      scope: "shared",
    });
    expect(listed.json).toEqual({ saved_queries: [], truncated: false });
  });

  it("refuses a token without zeteo.data.read like the other tools, and annotates the tools", async () => {
    const without = await connectMcp(mcpToken([MCP_USE]));
    try {
      const { tools } = await without.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      for (const name of [
        "list_saved_queries",
        "get_saved_query",
        "run_saved_query",
      ]) {
        expect(byName[name]?.annotations?.readOnlyHint, name).toBe(true);
      }
      for (const name of ["create_saved_query", "update_saved_query"]) {
        expect(byName[name]?.annotations?.readOnlyHint, name).toBe(false);
      }
      expect(byName.delete_saved_query?.annotations?.destructiveHint).toBe(
        true
      );
      const call = await callTool(without.client, "list_saved_queries");
      expect(call.isError).toBe(true);
      expect(call.json).toEqual({
        error: "forbidden",
        error_description: "Requires the zeteo.data.read permission",
        request_id: expect.any(String),
      });
    } finally {
      await without.close();
    }
  });

  it("lists no tools to a token without zeteo.mcp.use", async () => {
    const bare = await connectMcp(mcpToken([DATA_READ]));
    try {
      const { tools } = await bare.client.listTools();
      expect(tools).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it("reads a saved query created over the API by the same user", async () => {
    const id = await savedQueryOf(
      tokenFor({ userId, permissions: [DATA_READ] }),
      source
    );
    const got = await callTool(session.client, "get_saved_query", { id });
    expect(got.isError).toBe(false);
    expect(got.json.id).toBe(id);
  });
});
