// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDashboardsOf } from "../support/panelDecisions.js";
import { uniqueName } from "../support/savedQueries.js";
import { removeSources } from "../support/sources.js";
import { BAR, TABLE } from "../support/dashboards.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
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

describe("MCP saved panel tools", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  const savedQuery = async () => {
    const made = await callTool(session.client, "create_saved_query", {
      name: uniqueName("mcpsp"),
      query: {
        source: source.slug,
        from: "orders",
        select: ["id", "status", "total"],
      },
    });
    return made.json.id as string;
  };

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpsp");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, "all");
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeDashboardsOf([userId]);
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("tells the model that preview_panel reads at most 100 rows, unlike the dashboard", async () => {
    const { tools } = await session.client.listTools();
    const preview = tools.find((t) => t.name === "preview_panel")!;
    expect(preview.description).toContain("reads at most 100 rows");
    expect(preview.description).toContain(
      "That is the preview's limit, not the saved query's or the dashboard's"
    );
    expect(preview.description).toContain("up to 1,000 rows");
    expect(preview.description).toContain("saved_query_id or query");
  });

  it("creates, lists, reads, updates and deletes a saved panel, with no owner id", async () => {
    const query = await savedQuery();
    const name = uniqueName("sp");
    const created = await callTool(session.client, "create_saved_panel", {
      name,
      description: "totals",
      saved_query_id: query,
      chart: BAR,
    });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({
      name,
      state: "ok",
      chart: BAR,
      saved_query_id: query,
    });
    expect(created.json.owner).not.toHaveProperty("id");
    const id = created.json.id as string;

    const listed = await callTool(session.client, "list_saved_panels");
    expect(listed.json.saved_panels.map((p: { id: string }) => p.id)).toContain(
      id
    );
    for (const p of listed.json.saved_panels) {
      expect(p.owner).not.toHaveProperty("id");
    }
    expect(
      (await callTool(session.client, "get_saved_panel", { id })).json
    ).toEqual(created.json);

    const renamed = uniqueName("renamed");
    const updated = await callTool(session.client, "update_saved_panel", {
      id,
      name: renamed,
      chart: { ...BAR, horizontal: true },
    });
    expect(updated.json).toMatchObject({ name: renamed });
    expect(updated.json.chart).toMatchObject({ horizontal: true });

    const bad = await callTool(session.client, "update_saved_panel", {
      id,
      chart: { ...BAR, y: ["nope"] },
    });
    expect(bad.isError).toBe(true);
    expect(bad.json.error).toBe("invalid_panel");

    expect(
      (await callTool(session.client, "delete_saved_panel", { id })).json
    ).toEqual({ deleted: true });
    const gone = await callTool(session.client, "get_saved_panel", { id });
    expect(gone.json.error).toBe("not_found");
  });

  it("links a saved panel to a dashboard, then detaches it into an own panel", async () => {
    const query = await savedQuery();
    const saved = await callTool(session.client, "create_saved_panel", {
      name: uniqueName("sp"),
      saved_query_id: query,
      chart: BAR,
    });
    const dashboard = await callTool(session.client, "create_dashboard", {
      name: uniqueName("mcpsp"),
    });
    const linked = await callTool(session.client, "link_saved_panel", {
      dashboard_id: dashboard.json.id,
      saved_panel_id: saved.json.id,
      title: "Linked",
    });
    expect(linked.isError, linked.text).toBe(false);
    expect(linked.json).toMatchObject({
      kind: "linked",
      state: "ok",
      saved_panel_id: saved.json.id,
    });

    const blocked = await callTool(session.client, "update_panel", {
      dashboard_id: dashboard.json.id,
      panel_id: linked.json.id,
      chart: BAR,
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.json.error).toBe("invalid_panel");

    const detached = await callTool(session.client, "detach_panel", {
      dashboard_id: dashboard.json.id,
      panel_id: linked.json.id,
    });
    expect(detached.isError, detached.text).toBe(false);
    expect(detached.json).toMatchObject({
      id: linked.json.id,
      kind: "own",
      title: "Linked",
      chart: BAR,
      saved_query_id: query,
    });
  });

  it("preview_panel previews a query that is not saved: rows, problems and time_range", async () => {
    const query = {
      source: source.slug,
      from: "orders",
      select: ["id", "status", "total"],
      orderBy: [{ id: "asc" }],
    };
    const whole = await callTool(session.client, "preview_panel", {
      query,
      chart: { ...BAR, y: ["total", "revenue"] },
    });
    expect(whole.isError, whole.text).toBe(false);
    expect(Object.keys(whole.json).sort()).toEqual([
      "columns",
      "problems",
      "row_count",
      "rows",
      "truncated",
    ]);
    expect(whole.json.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "status",
      "total",
    ]);
    expect(whole.json.row_count).toBe(12);
    expect(whole.json.rows).toHaveLength(12);
    expect(whole.json.rows[0]).toEqual([1, "paid", "10.00"]);
    expect(whole.json.truncated).toBe(false);
    expect(whole.json.problems).toEqual([
      { setting: "y.1", problem: "missing_column" },
    ]);

    // Every fixture order is older than 30 days.
    const filtered = await callTool(session.client, "preview_panel", {
      query,
      chart: BAR,
      time_column: "created_at",
      time_range: "last_30_days",
    });
    expect(filtered.isError, filtered.text).toBe(false);
    expect(filtered.json).toMatchObject({
      row_count: 0,
      rows: [],
      problems: [],
    });
  });

  it("preview_panel with a query is recorded as an mcp run with no saved query", async () => {
    const call = await callTool(session.client, "preview_panel", {
      query: {
        source: source.slug,
        from: "orders",
        select: ["id", "status", { count: "*", as: "n" }],
        groupBy: ["id", "status"],
      },
      chart: TABLE,
    });
    expect(call.isError, call.text).toBe(false);
    const runs = await runsOf([userId]);
    const last = runs[runs.length - 1]!;
    expect(last.outcome).toBe("ok");
    expect(last.entryPoint).toBe("mcp");
    expect(last.savedQueryId).toBeNull();
    expect(last.sourceId).toBe(source.id);
    expect(JSON.stringify(last.query)).toContain('"as":"n"');
  });

  it("preview_panel refuses both a saved query and a query, and neither, with invalid_request", async () => {
    const id = await savedQuery();
    const query = { source: source.slug, from: "orders", select: ["id"] };
    for (const args of [
      { saved_query_id: id, query, chart: TABLE },
      { chart: TABLE },
    ]) {
      const call = await callTool(session.client, "preview_panel", args);
      expect(call.isError, JSON.stringify(args)).toBe(true);
      expect(call.json?.error, JSON.stringify(args)).toBe("invalid_request");
    }
  });

  it("deletes only the caller's own saved panels", async () => {
    const query = await savedQuery();
    const saved = await callTool(session.client, "create_saved_panel", {
      name: uniqueName("sp"),
      saved_query_id: query,
      chart: BAR,
    });
    const other = await connectMcp(mcpToken([MCP_USE, DATA_READ]));
    try {
      const call = await callTool(other.client, "delete_saved_panel", {
        id: saved.json.id,
      });
      expect(call.isError).toBe(true);
      expect(call.json.error).toBe("not_found");
    } finally {
      await other.close();
    }
  });
});
