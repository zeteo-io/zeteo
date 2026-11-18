// @module-tag int
// @module-tag platform
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDashboardsOf } from "../support/panelDecisions.js";
import { uniqueName } from "../support/savedQueries.js";
import { BAR, TABLE } from "../support/dashboards.js";
import { removeSources } from "../support/sources.js";
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

describe("MCP card tools", () => {
  let source: SeededSource;
  let session: McpSession;
  const userId = randomUUID();

  const savedQuery = async (query: Record<string, unknown>) => {
    const made = await callTool(session.client, "create_saved_query", {
      name: uniqueName("mcpcard"),
      query: { source: source.slug, ...query },
    });
    expect(made.isError, made.text).toBe(false);
    return made.json.id as string;
  };

  const dashboardOf = async (
    panels: Array<{ saved_query_id: string; chart: unknown; title?: string }>
  ) => {
    const made = await callTool(session.client, "create_dashboard", {
      name: uniqueName("mcpcard"),
      time_range: "last_30_days",
    });
    expect(made.isError, made.text).toBe(false);
    const ids: string[] = [];
    for (const panel of panels) {
      const added = await callTool(session.client, "add_panel", {
        dashboard_id: made.json.id,
        ...panel,
      });
      expect(added.isError, added.text).toBe(false);
      ids.push(added.json.id as string);
    }
    return { id: made.json.id as string, panelIds: ids };
  };

  beforeAll(async () => {
    source = await seedQuerySource(
      postgres,
      { schemas: [...postgres.schemas, "probe"] },
      "mcpcard"
    );
    const me = { type: "user" as const, id: userId };
    await grantTo(me, source.tables.orders!, "all");
    await grantTo(me, source.tables.wide_rows!, "all");
    session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  });
  afterAll(async () => {
    await session?.close();
    await removeDashboardsOf([userId]);
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("describes both tools as the card's, never for answering questions", async () => {
    const { tools } = await session.client.listTools();
    for (const name of ["card_panel_rows", "card_dashboard"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(
        /^Used by zeteo's preview card; not for answering questions\./
      );
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it("card_panel_rows returns every row of a 50-row query, not the preview's 20", async () => {
    const query = await savedQuery({
      from: "wide_rows",
      select: ["id"],
      orderBy: [{ id: "asc" }],
      limit: 50,
    });
    const call = await callTool(session.client, "card_panel_rows", {
      saved_query_id: query,
      chart: TABLE,
    });
    expect(call.isError, call.text).toBe(false);
    expect(call.json).toMatchObject({
      title: null,
      chart: TABLE,
      problems: [],
    });
    expect(call.json.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
    ]);
    expect(call.json.rows).toHaveLength(50);
  });

  it("card_panel_rows gives the same problems as preview_panel", async () => {
    const query = await savedQuery({
      from: "orders",
      select: ["id", "status", "total"],
    });
    const chart = { ...BAR, y: ["total", "revenue"] };
    const [card, preview] = await Promise.all([
      callTool(session.client, "card_panel_rows", {
        saved_query_id: query,
        chart,
        time_column: "created_at",
        time_range: "last_30_days",
      }),
      callTool(session.client, "preview_panel", {
        saved_query_id: query,
        chart,
        time_column: "created_at",
        time_range: "last_30_days",
      }),
    ]);
    expect(card.isError, card.text).toBe(false);
    expect(card.json.problems).toEqual(preview.json.problems);
    expect(card.json.problems).toEqual([
      { setting: "y.1", problem: "missing_column" },
    ]);
    expect(card.json.columns).toEqual(preview.json.columns);
  });

  it("card_panel_rows by saved_panel_id returns its chart and title", async () => {
    const query = await savedQuery({
      from: "orders",
      select: ["id", "status", "total"],
    });
    const name = uniqueName("cardsp");
    const made = await callTool(session.client, "create_saved_panel", {
      name,
      saved_query_id: query,
      chart: BAR,
    });
    expect(made.isError, made.text).toBe(false);
    const call = await callTool(session.client, "card_panel_rows", {
      saved_panel_id: made.json.id,
    });
    expect(call.isError, call.text).toBe(false);
    expect(call.json).toMatchObject({
      title: name,
      chart: BAR,
      truncated: false,
      problems: [],
    });
    expect(call.json.rows).toHaveLength(12);
  });

  it("card_panel_rows refuses neither or both forms with invalid_request", async () => {
    for (const args of [
      {},
      { saved_query_id: "x" },
      { saved_panel_id: "x", saved_query_id: "y", chart: TABLE },
    ]) {
      const call = await callTool(session.client, "card_panel_rows", args);
      expect(call.isError, JSON.stringify(args)).toBe(true);
      expect(call.json?.error, JSON.stringify(args)).toBe("invalid_request");
    }
  });

  it("card_dashboard without panel_ids returns the layout and runs nothing", async () => {
    const query = await savedQuery({
      from: "orders",
      select: ["id", "status", "total"],
    });
    const dash = await dashboardOf([
      { saved_query_id: query, chart: BAR, title: "Totals" },
      { saved_query_id: query, chart: TABLE },
    ]);
    const before = (await runsOf([userId])).length;
    const call = await callTool(session.client, "card_dashboard", {
      dashboard_id: dash.id,
    });
    expect(call.isError, call.text).toBe(false);
    expect(Object.keys(call.json).sort()).toEqual([
      "id",
      "name",
      "panels",
      "time_range",
      "url",
    ]);
    expect(call.json.id).toBe(dash.id);
    expect(call.json.time_range).toBe("last_30_days");
    expect(call.json.url === null || typeof call.json.url === "string").toBe(
      true
    );
    expect(call.json.panels).toHaveLength(2);
    const [first] = call.json.panels;
    expect(first).toEqual({
      id: dash.panelIds[0],
      x: expect.any(Number),
      y: expect.any(Number),
      w: expect.any(Number),
      h: expect.any(Number),
      title: "Totals",
      state: "ok",
      chart: BAR,
    });
    expect((await runsOf([userId])).length).toBe(before);
  });

  it("card_dashboard with two panel_ids returns two lines, recorded as dashboard runs", async () => {
    const a = await savedQuery({ from: "orders", select: ["id", "status"] });
    const b = await savedQuery({
      from: "orders",
      select: ["id", "status", "total"],
    });
    const dash = await dashboardOf([
      { saved_query_id: a, chart: TABLE },
      { saved_query_id: b, chart: BAR },
      { saved_query_id: a, chart: TABLE, title: "not asked for" },
    ]);
    const asked = dash.panelIds.slice(0, 2);
    const call = await callTool(session.client, "card_dashboard", {
      dashboard_id: dash.id,
      panel_ids: asked,
    });
    expect(call.isError, call.text).toBe(false);
    expect(Object.keys(call.json)).toEqual(["panels"]);
    expect(call.json.panels).toHaveLength(2);
    expect(
      call.json.panels.map((l: { panel_id: string }) => l.panel_id).sort()
    ).toEqual([...asked].sort());
    for (const line of call.json.panels) {
      expect(line.state).toBe("ok");
      expect(line.result.rows).toHaveLength(12);
      expect(line).not.toHaveProperty("done");
    }
    const runs = (await runsOf([userId])).filter(
      (r) => r.savedQueryId === a || r.savedQueryId === b
    );
    expect(runs.map((r) => r.savedQueryId).sort()).toEqual([a, b].sort());
    for (const run of runs) expect(run.entryPoint).toBe("dashboard");
  });

  it("card_dashboard refuses five panel_ids with invalid_request", async () => {
    const call = await callTool(session.client, "card_dashboard", {
      dashboard_id: "anything",
      panel_ids: ["a", "b", "c", "d", "e"],
    });
    expect(call.isError).toBe(true);
    expect(call.json.error).toBe("invalid_request");
  });

  it("card_dashboard answers a panel too large for one result with too_large", async () => {
    const big = await savedQuery({
      from: "wide_rows",
      select: ["id", "filler"],
      orderBy: [{ id: "asc" }],
      limit: 1000,
    });
    const small = await savedQuery({
      from: "orders",
      select: ["id", "status"],
    });
    const dash = await dashboardOf([
      { saved_query_id: big, chart: TABLE },
      { saved_query_id: small, chart: TABLE },
    ]);
    const call = await callTool(session.client, "card_dashboard", {
      dashboard_id: dash.id,
      panel_ids: dash.panelIds,
    });
    expect(call.isError, call.text.slice(0, 200)).toBe(false);
    const byId = Object.fromEntries(
      call.json.panels.map((l: { panel_id?: string; id?: string }) => [
        l.panel_id ?? l.id,
        l,
      ])
    );
    expect(byId[dash.panelIds[0]!]).toEqual({
      id: dash.panelIds[0],
      state: "too_large",
    });
    expect(byId[dash.panelIds[1]!].state).toBe("ok");
    expect(byId[dash.panelIds[1]!].result.rows).toHaveLength(12);
  }, 60_000);
});
