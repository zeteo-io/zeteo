// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../../../support/panelDecisions.js";
import { removeSources } from "../../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../../../../../support/engines.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
} from "../../../../../../../support/savedPanels.js";
import {
  BAR,
  chartedQuery,
  dashboardOf,
  dashboardsCall,
  ownPanel,
} from "../../../../../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../../../support/queries.js";

describe("POST /v1/dashboards/:dashboardId/panels/:panelId/save", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };
  const save = (id: string, panel: string, token: string, body: unknown) =>
    dashboardsCall("POST", `/${id}/panels/${panel}/save`, token, body);
  const firstPanel = async (token: string, dash: string) =>
    (await dashboardsCall("GET", `/${dash}`, token)).body.panels[0]
      .id as string;

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "panelsave");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("saves an own panel as a saved panel the owner then lists", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const dash = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const name = uniqueName("saved");
    const res = await save(
      dash,
      await firstPanel(owner.token, dash),
      owner.token,
      {
        name,
        description: "d",
      }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      name,
      description: "d",
      state: "ok",
      chart: BAR,
      saved_query_id: sq,
    });
    const mine = await savedPanelsCall("GET", "", owner.token);
    expect(mine.body.data.map((d: { id: string }) => d.id)).toEqual([
      res.body.id,
    ]);
  });

  it("refuses a linked panel and a panel that is not ok with invalid_panel", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const sp = await savedPanelOf(owner.token, sq);
    const dash = await dashboardOf(owner.token, {
      panels: [{ kind: "linked", saved_panel_id: sp }, ownPanel(sq)],
    });
    const panels = (await dashboardsCall("GET", `/${dash}`, owner.token)).body
      .panels;
    const linked = await save(dash, panels[0].id, owner.token, {
      name: uniqueName(),
    });
    expect(linked.status).toBe(400);
    expect(linked.body.error).toBe("invalid_panel");
    // Deleting the saved query leaves the own panel not ok.
    const { prisma } =
      await import("../../../../../../../../utils/db/prisma.js");
    await prisma.savedQuery.delete({ where: { id: sq } });
    const broken = await save(dash, panels[1].id, owner.token, {
      name: uniqueName(),
    });
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe("invalid_panel");
  });

  it("answers 404 to anyone but the dashboard's owner", async () => {
    const owner = await user();
    const other = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const dash = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const res = await save(
      dash,
      await firstPanel(owner.token, dash),
      other.token,
      {
        name: uniqueName(),
      }
    );
    expect(res.status).toBe(404);
  });

  it("answers 409 for a name the owner already has, and 400 for a bad body", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const name = uniqueName("dup");
    await savedPanelOf(owner.token, sq, { name });
    const dash = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const panel = await firstPanel(owner.token, dash);
    const dup = await save(dash, panel, owner.token, {
      name: name.toUpperCase(),
    });
    expect(dup.status).toBe(409);
    expect((await save(dash, panel, owner.token, { name: "" })).status).toBe(
      400
    );
    expect(
      (await save(dash, panel, owner.token, { name: "x", extra: 1 })).status
    ).toBe(400);
  });
});
