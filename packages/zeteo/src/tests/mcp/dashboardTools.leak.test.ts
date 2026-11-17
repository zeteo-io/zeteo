// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { grantTo, newQueryUser, removeGrant } from "../support/queries.js";
import { shareSavedPanelDirectly } from "../support/savedPanels.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, connectMcp, mcpToken } from "../support/mcp.js";
import { shareDashboardDirectly } from "../support/dashboards.js";
import { db } from "../../utils/db/index.js";
import {
  causeQueryOn,
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
  type NoAccessCase,
} from "../support/savedQueryCauses.js";
import {
  dashboardWith,
  removeDashboardsOf,
} from "../support/panelDecisions.js";

// What a caller who cannot run a saved query is told through the dashboard and
// saved panel tools is the same for each of the seven causes: the generic
// notice, and no chart, time column, ids, names or planner detail.

const NOTICE =
  "You need expanded permissions to run this saved query. Ask an admin to extend your access.";
const CHART = {
  type: "table",
  version: 1,
  columns: ["id", "status", "customers.region"],
};
const FIXTURE_NAMES = ["orders", "customers", "status", "region", "created_at"];

const as = async <R>(
  userId: string,
  work: (c: Awaited<ReturnType<typeof connectMcp>>["client"]) => Promise<R>
) => {
  const session = await connectMcp(mcpToken([MCP_USE, DATA_READ], userId));
  try {
    return await work(session.client);
  } finally {
    await session.close();
  }
};

describe("MCP dashboard tools: seven causes of no access", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  let cases: NoAccessCase[];
  const users: string[] = [];
  const everyone: Array<{
    cause: string;
    userId: string;
    savedQueryId: string;
  }> = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "mcpdleak");
    users.push(sources.owner.id);
    cases = await setUpNoAccessCases(sources, sources.owner);
    users.push(...cases.map((c) => c.recipient.id));
    for (const c of cases) {
      everyone.push({
        cause: c.cause,
        userId: c.recipient.id,
        savedQueryId: c.id,
      });
    }
    // 7. a time column the viewer cannot see: everything granted but orders.created_at
    const noTime = newQueryUser();
    users.push(noTime.id);
    const orders = sources.source.tables.orders!;
    await grantTo(
      noTime.principal,
      orders,
      Object.keys(orders.columns).filter((c) => c !== "created_at")
    );
    await grantTo(noTime.principal, sources.source.tables.customers!, "all");
    const own = await db.savedQueries.create({
      ownerId: sources.owner.id,
      sourceId: sources.source.id,
      name: "time leak",
      description: "",
      query: causeQueryOn(sources.source),
    });
    everyone.push({
      cause: "a time column not granted",
      userId: noTime.id,
      savedQueryId: own.id,
    });
  });
  afterAll(async () => {
    await removeDashboardsOf([sources.owner.id]);
    await removeNoAccessCases(sources, users);
  });

  it("get_dashboard and get_saved_panel show the same body, with no chart, ids or fixture names", async () => {
    const dashboards: unknown[] = [];
    const panels: unknown[] = [];
    for (const { cause, userId, savedQueryId } of everyone) {
      const dash = await dashboardWith(sources.owner.id, [
        {
          kind: "own",
          savedQueryId,
          chart: CHART,
          timeColumn: "created_at",
          title: cause,
        },
      ]);
      await shareDashboardDirectly(
        dash.id,
        { type: "user", id: userId },
        sources.owner.id
      );
      const saved = await db.savedPanels.create({
        ownerId: sources.owner.id,
        name: `panel ${cause}`,
        description: "",
        savedQueryId,
        chart: CHART,
        timeColumn: "created_at",
      });
      await shareSavedPanelDirectly(
        saved.id,
        { type: "user", id: userId },
        sources.owner.id
      );
      const [d, p] = await as(userId, async (client) => [
        await callTool(client, "get_dashboard", { id: dash.id }),
        await callTool(client, "get_saved_panel", { id: saved.id }),
      ]);
      expect(d.isError, cause).toBe(false);
      const panel = d.json.panels[0];
      expect(panel.state, cause).toBe("not_accessible");
      for (const key of [
        "chart",
        "time_column",
        "saved_query_id",
        "saved_panel_id",
        "problems",
      ]) {
        expect(panel, `${cause} ${key}`).not.toHaveProperty(key);
      }
      const { id: _i, title: _t, ...rest } = panel;
      dashboards.push(rest);

      expect(p.isError, cause).toBe(false);
      expect(p.json.state, cause).toBe("not_accessible");
      for (const key of [
        "chart",
        "time_column",
        "saved_query_id",
        "problems",
      ]) {
        expect(p.json, `${cause} ${key}`).not.toHaveProperty(key);
      }
      panels.push({ state: p.json.state, message: p.json.message });

      const raw = JSON.stringify([panel.message, p.json.message, rest]);
      for (const name of FIXTURE_NAMES) expect(raw, cause).not.toContain(name);
      for (const on of [sources.source, sources.archived, sources.missing]) {
        expect(raw, cause).not.toContain(on.slug);
        expect(raw, cause).not.toContain(on.id);
      }
    }
    expect(dashboards).toHaveLength(7);
    for (const d of dashboards) expect(d).toEqual(dashboards[0]);
    expect(dashboards[0]).toEqual({
      kind: "own",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      state: "not_accessible",
      message: NOTICE,
    });
    for (const p of panels) expect(p).toEqual(panels[0]);
  });

  it("preview_panel gives the same tool error for the six causes of no access to a saved query", async () => {
    const bodies: unknown[] = [];
    for (const { cause, recipient, id } of cases) {
      const call = await as(recipient.id, (client) =>
        callTool(client, "preview_panel", { saved_query_id: id, chart: CHART })
      );
      expect(call.isError, cause).toBe(true);
      expect(call.json.error, cause).toBe("saved_query_not_accessible");
      expect(call.json.error_description, cause).toBe(NOTICE);
      const { request_id: _r, ...rest } = call.json;
      bodies.push(rest);
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const text = JSON.stringify(bodies);
    for (const on of [sources.source, sources.archived, sources.missing]) {
      expect(text).not.toContain(on.slug);
      expect(text).not.toContain(on.id);
    }
    expect(text).not.toMatch(/orders|customers|"path"|candidates|problems/);
  });
});

describe("MCP update_panel and remove_panel after the owner's access narrows", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const owner = newQueryUser();

  beforeAll(async () => {
    sources = await seedCauseSources({}, "mcpdnarrow");
  });
  afterAll(async () => {
    await removeDashboardsOf([owner.id, sources.owner.id]);
    await removeNoAccessCases(sources, [owner.id, sources.owner.id]);
  });

  it("gives the generic notice for an update, never the chart or planner detail, while the owner may still remove the panel", async () => {
    const { orders, customers } = sources.source.tables as Record<
      string,
      NonNullable<(typeof sources.source.tables)[string]>
    >;
    const wide = [
      await grantTo(owner.principal, orders!, "all"),
      await grantTo(owner.principal, customers!, "all"),
    ];
    const query = await db.savedQueries.create({
      ownerId: owner.id,
      sourceId: sources.source.id,
      name: "narrowing",
      description: "",
      query: causeQueryOn(sources.source),
    });
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: query.id, chart: CHART },
    ]);
    const panelId = dash.panels[0]!.id;
    // The owner's access narrows to one column.
    for (const grant of wide) await removeGrant(grant);
    await grantTo(owner.principal, orders!, ["id"]);

    const update = await as(owner.id, (client) =>
      callTool(client, "update_panel", {
        dashboard_id: dash.id,
        panel_id: panelId,
        chart: { type: "table", version: 1, columns: ["id"] },
      })
    );
    expect(update.isError).toBe(true);
    expect(update.json.error).toBe("saved_query_not_accessible");
    expect(update.json.error_description).toBe(NOTICE);
    expect(update.json).not.toHaveProperty("problems");
    expect(update.text).not.toMatch(/customers|status|region|columns/);

    const retitle = await as(owner.id, (client) =>
      callTool(client, "update_panel", {
        dashboard_id: dash.id,
        panel_id: panelId,
        title: "Still mine",
      })
    );
    expect(retitle.isError).toBe(true);
    expect(retitle.json.error).toBe("saved_query_not_accessible");

    const got = await as(owner.id, (client) =>
      callTool(client, "get_dashboard", { id: dash.id })
    );
    expect(got.json.panels[0]).not.toHaveProperty("chart");

    const removed = await as(owner.id, (client) =>
      callTool(client, "remove_panel", {
        dashboard_id: dash.id,
        panel_id: panelId,
      })
    );
    expect(removed.isError, removed.text).toBe(false);
    expect(removed.json).toEqual({ removed: true });
  });
});
