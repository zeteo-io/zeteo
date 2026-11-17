// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { dashboardsCall, BAR, TABLE } from "../support/dashboards.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDashboardsOf } from "../support/panelDecisions.js";
import { uniqueName } from "../support/savedQueries.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { tokenFor } from "../support/tokens.js";
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

describe("MCP dashboard tools", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  const savedQuery = async (select: string[]) => {
    const made = await callTool(session.client, "create_saved_query", {
      name: uniqueName("mcpdash"),
      query: { source: source.slug, from: "orders", select },
    });
    expect(made.isError, made.text).toBe(false);
    return made.json.id as string;
  };

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpdash");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, "all");
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeDashboardsOf([userId]);
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("builds a two-panel dashboard purely through tools, and the API reads it back", async () => {
    const barQuery = await savedQuery(["id", "status", "total"]);
    const tableQuery = await savedQuery(["id", "status"]);

    const preview = await callTool(session.client, "preview_panel", {
      saved_query_id: barQuery,
      chart: BAR,
    });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json.problems).toEqual([]);
    expect(preview.json.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "status",
      "total",
    ]);
    expect(preview.json.rows.length).toBeLessThanOrEqual(20);
    expect(preview.json.row_count).toBeGreaterThan(0);
    expect(preview.json.truncated).toBe(false);

    const created = await callTool(session.client, "create_dashboard", {
      name: uniqueName("mcpdash"),
      description: "built by a model",
      time_range: "last_30_days",
    });
    expect(created.isError, created.text).toBe(false);
    expect(created.json.owner).not.toHaveProperty("id");
    const id = created.json.id as string;

    const first = await callTool(session.client, "add_panel", {
      dashboard_id: id,
      saved_query_id: barQuery,
      chart: BAR,
      title: "Totals",
    });
    expect(first.isError, first.text).toBe(false);
    expect(first.json).toMatchObject({
      kind: "own",
      state: "ok",
      title: "Totals",
    });
    const second = await callTool(session.client, "add_panel", {
      dashboard_id: id,
      saved_query_id: tableQuery,
      chart: TABLE,
    });
    expect(second.isError, second.text).toBe(false);
    // Default sizes, first free place: the 6x4 bar, then the 12x4 table below it.
    expect(first.json).toMatchObject({ x: 0, y: 0, w: 6, h: 4 });
    expect(second.json).toMatchObject({ x: 0, w: 12, h: 4 });
    expect(second.json.y).toBeGreaterThanOrEqual(4);

    const got = await callTool(session.client, "get_dashboard", { id });
    expect(got.json.panels).toHaveLength(2);
    expect(got.json.owner).not.toHaveProperty("id");

    const api = await dashboardsCall(
      "GET",
      `/${id}`,
      tokenFor({ userId, permissions: [DATA_READ] })
    );
    expect(api.status).toBe(200);
    expect(api.body.name).toBe(created.json.name);
    expect(api.body.time_range).toBe("last_30_days");
    expect(api.body.panels.map((p: { id: string }) => p.id).sort()).toEqual(
      [first.json.id, second.json.id].sort()
    );
    for (const p of api.body.panels) expect(p.state).toBe("ok");
    expect(
      api.body.panels.find((p: { id: string }) => p.id === first.json.id).chart
    ).toEqual(BAR);

    const listed = await callTool(session.client, "list_dashboards");
    expect(listed.json.truncated).toBe(false);
    expect(listed.json.dashboards.map((d: { id: string }) => d.id)).toContain(
      id
    );
    for (const d of listed.json.dashboards) {
      expect(d.owner).not.toHaveProperty("id");
    }
  });

  it("updates settings and a panel, removes a panel, and deletes the dashboard", async () => {
    const query = await savedQuery(["id", "status", "total"]);
    const made = await callTool(session.client, "create_dashboard", {
      name: uniqueName("mcpdash"),
    });
    const id = made.json.id as string;
    const panel = await callTool(session.client, "add_panel", {
      dashboard_id: id,
      saved_query_id: query,
      chart: BAR,
      x: 0,
      y: 0,
    });

    const renamed = uniqueName("renamed");
    const updated = await callTool(session.client, "update_dashboard", {
      id,
      name: renamed,
      theme: "dark",
    });
    expect(updated.json).toMatchObject({ name: renamed, theme: "dark" });
    expect(updated.json.panels).toHaveLength(1);

    const moved = await callTool(session.client, "update_panel", {
      dashboard_id: id,
      panel_id: panel.json.id,
      title: "Moved",
      w: 12,
    });
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.json).toMatchObject({ title: "Moved", w: 12, x: 0 });

    const bad = await callTool(session.client, "update_panel", {
      dashboard_id: id,
      panel_id: panel.json.id,
      chart: { ...BAR, x: "no_such_column" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.json.error).toBe("invalid_panel");
    expect(bad.json.problems).toEqual([
      { setting: "x", problem: "missing_column" },
    ]);

    const removed = await callTool(session.client, "remove_panel", {
      dashboard_id: id,
      panel_id: panel.json.id,
    });
    expect(removed.json).toEqual({ removed: true });
    expect(
      (await callTool(session.client, "get_dashboard", { id })).json.panels
    ).toEqual([]);

    const deleted = await callTool(session.client, "delete_dashboard", { id });
    expect(deleted.json).toEqual({ deleted: true });
    const gone = await callTool(session.client, "get_dashboard", { id });
    expect(gone.isError).toBe(true);
    expect(gone.json.error).toBe("not_found");
  });

  it("preview_panel reports a missing_column problem, filters by time and records every call", async () => {
    const query = await savedQuery(["id", "status", "total"]);
    const before = await callTool(session.client, "preview_panel", {
      saved_query_id: query,
      chart: { ...BAR, y: ["total", "revenue"] },
    });
    expect(before.isError, before.text).toBe(false);
    expect(before.json.problems).toEqual([
      { setting: "y.1", problem: "missing_column" },
    ]);

    // A time column the saved query does not select still filters (it is a column of the table).
    const filtered = await callTool(session.client, "preview_panel", {
      saved_query_id: query,
      chart: BAR,
      time_column: "created_at",
      time_range: "last_hour",
    });
    expect(filtered.isError, filtered.text).toBe(false);

    const runs = await runsOf([userId]);
    const previews = runs.filter((r) => r.savedQueryId === query);
    expect(previews.length).toBeGreaterThanOrEqual(2);
    for (const run of previews) expect(run.entryPoint).toBe("mcp");
  });

  it("deletes only the caller's own dashboards", async () => {
    const other = await connectMcp(mcpToken([MCP_USE, DATA_READ]));
    try {
      const made = await callTool(session.client, "create_dashboard", {
        name: uniqueName("mcpdash"),
      });
      const call = await callTool(other.client, "delete_dashboard", {
        id: made.json.id,
      });
      expect(call.isError).toBe(true);
      expect(call.json.error).toBe("not_found");
    } finally {
      await other.close();
    }
  });
});
