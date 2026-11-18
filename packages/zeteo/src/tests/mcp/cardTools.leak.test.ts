// @module-tag int
// @module-tag platform
// @module-tag security
import { DATA_READ, MCP_USE } from "../../definitions/tereoDeclaration.js";
import { shareSavedPanelDirectly } from "../support/savedPanels.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, connectMcp, mcpToken } from "../support/mcp.js";
import { shareDashboardDirectly } from "../support/dashboards.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { db } from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
  type NoAccessCase,
} from "../support/savedQueryCauses.js";
import {
  dashboardWith,
  removeDashboardsOf,
} from "../support/panelDecisions.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// A viewer who cannot run a panel's saved query learns nothing of it through
// the card's tools: the generic notice, and no rows, columns or chart.

const NOTICE =
  "You need expanded permissions to run this saved query. Ask an admin to extend your access.";
const CHART = {
  type: "table",
  version: 1,
  columns: ["id", "status", "customers.region"],
};
const postgres = ENGINES.find((e) => e.type === "postgres")!;
const FIXTURE_NAMES = ["orders", "customers", "status", "region"];

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

describe("MCP card tools: a viewer without access", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  let cases: NoAccessCase[];
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "mcpcleak");
    users.push(sources.owner.id);
    cases = await setUpNoAccessCases(sources, sources.owner);
    users.push(...cases.map((c) => c.recipient.id));
  });
  afterAll(async () => {
    await removeDashboardsOf([sources.owner.id]);
    await removeNoAccessCases(sources, users);
  });

  it("card_dashboard gives not_accessible panels with no rows, columns or chart", async () => {
    for (const { cause, recipient, id } of cases) {
      const dash = await dashboardWith(sources.owner.id, [
        { kind: "own", savedQueryId: id, chart: CHART, title: cause },
      ]);
      await shareDashboardDirectly(
        dash.id,
        { type: "user", id: recipient.id },
        sources.owner.id
      );
      const panelId = dash.panels[0]!.id;
      const [layout, run] = await as(recipient.id, async (client) => [
        await callTool(client, "card_dashboard", { dashboard_id: dash.id }),
        await callTool(client, "card_dashboard", {
          dashboard_id: dash.id,
          panel_ids: [panelId],
        }),
      ]);
      expect(layout.isError, cause).toBe(false);
      expect(layout.json.panels[0], cause).toEqual({
        id: panelId,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        title: cause,
        state: "not_accessible",
        message: NOTICE,
      });
      expect(run.isError, cause).toBe(false);
      expect(run.json.panels, cause).toEqual([
        { panel_id: panelId, state: "not_accessible", message: NOTICE },
      ]);
      const raw = JSON.stringify([layout.json, run.json]).replace(cause, "");
      for (const name of FIXTURE_NAMES) expect(raw, cause).not.toContain(name);
      for (const on of [sources.source, sources.archived, sources.missing]) {
        expect(raw, cause).not.toContain(on.slug);
        expect(raw, cause).not.toContain(on.id);
      }
    }
  });

  it("card_panel_rows gives preview_panel's error, by saved query and by saved panel", async () => {
    for (const { cause, recipient, id } of cases) {
      const saved = await db.savedPanels.create({
        ownerId: sources.owner.id,
        name: `card ${cause}`,
        description: "",
        savedQueryId: id,
        chart: CHART,
        timeColumn: null,
      });
      await shareSavedPanelDirectly(
        saved.id,
        { type: "user", id: recipient.id },
        sources.owner.id
      );
      const [card, preview, byPanel] = await as(
        recipient.id,
        async (client) => [
          await callTool(client, "card_panel_rows", {
            saved_query_id: id,
            chart: CHART,
          }),
          await callTool(client, "preview_panel", {
            saved_query_id: id,
            chart: CHART,
          }),
          await callTool(client, "card_panel_rows", {
            saved_panel_id: saved.id,
          }),
        ]
      );
      for (const call of [card, byPanel]) {
        expect(call.isError, cause).toBe(true);
        const { request_id: _r, ...rest } = call.json;
        const { request_id: _p, ...expected } = preview.json;
        expect(rest, cause).toEqual(expected);
        expect(rest.error, cause).toBe("saved_query_not_accessible");
        expect(call.text, cause).not.toMatch(/"rows"|"columns"|"chart"/);
      }
    }
  });

  it("card_dashboard on a dashboard not shared with the caller is get_dashboard's not-found", async () => {
    const dash = await dashboardWith(sources.owner.id, [
      { kind: "own", savedQueryId: cases[0]!.id, chart: CHART },
    ]);
    const stranger = newQueryUser();
    users.push(stranger.id);
    const [get, layout, run] = await as(stranger.id, async (client) => [
      await callTool(client, "get_dashboard", { id: dash.id }),
      await callTool(client, "card_dashboard", { dashboard_id: dash.id }),
      await callTool(client, "card_dashboard", {
        dashboard_id: dash.id,
        panel_ids: [dash.panels[0]!.id],
      }),
    ]);
    const { request_id: _g, ...expected } = get.json;
    expect(expected.error).toBe("not_found");
    for (const call of [layout, run]) {
      expect(call.isError).toBe(true);
      const { request_id: _r, ...rest } = call.json;
      expect(rest).toEqual(expected);
    }
  });
});

describe("MCP card tools: a query that is not saved", () => {
  let source: SeededSource;
  const userId = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(postgres, {}, "mcpcqleak");
    await grantTo({ type: "user", id: userId }, source.tables.orders!, [
      "id",
      "status",
    ]);
  });
  afterAll(async () => {
    await removeRunsOf([userId]);
    await removeSources([source.id]);
  });

  it("card_panel_rows gives the query tool's error for an ungranted or invented column", async () => {
    for (const column of ["total", "zzqxw"]) {
      const query = {
        source: source.slug,
        from: "orders",
        select: ["id", column],
      };
      const [card, direct] = await as(userId, async (client) => [
        await callTool(client, "card_panel_rows", {
          query,
          chart: { type: "table", version: 1 },
        }),
        await callTool(client, "query", query),
      ]);
      expect(card.isError, column).toBe(true);
      const { request_id: _c, ...rest } = card.json;
      const { request_id: _q, ...expected } = direct.json;
      expect(rest, column).toEqual(expected);
      expect(rest.error, column).toBe("not_found_or_not_accessible");
      expect(card.text, column).not.toMatch(/"rows"|"columns"|"chart"/);
    }
  });
});
