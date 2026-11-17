// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../../../support/panelDecisions.js";
import { removeSources } from "../../../../../../../support/sources.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../../../../../support/engines.js";
import {
  savedQueryOf,
  userWithOrders,
} from "../../../../../../../support/savedQueries.js";
import {
  detachPanel,
  savedPanelOf,
  savedPanelsCall,
  shareSavedPanelDirectly,
} from "../../../../../../../support/savedPanels.js";
import {
  BAR,
  TABLE,
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

describe("POST /v1/dashboards/:dashboardId/panels/:panelId/detach", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "paneldetach");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  const linked = async (owner: Awaited<ReturnType<typeof user>>) => {
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const sp = await savedPanelOf(owner.token, sq);
    const dash = await dashboardOf(owner.token);
    const added = await dashboardsCall("POST", `/${dash}/panels`, owner.token, {
      kind: "linked",
      saved_panel_id: sp,
      title: "Mine",
      x: 3,
      y: 2,
    });
    return { sq, sp, dash, panel: added.body.id as string };
  };

  it("keeps the chart and drops the link; a later edit of the saved panel no longer changes it", async () => {
    const owner = await user();
    const { sq, sp, dash, panel } = await linked(owner);
    const res = await detachPanel(owner.token, dash, panel);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: panel,
      kind: "own",
      title: "Mine",
      x: 3,
      y: 2,
      state: "ok",
      chart: BAR,
      saved_query_id: sq,
    });
    expect(res.body).not.toHaveProperty("saved_panel_id");
    await savedPanelsCall("PATCH", `/${sp}`, owner.token, { chart: TABLE });
    const read = await dashboardsCall("GET", `/${dash}`, owner.token);
    expect(read.body.panels[0]).toMatchObject({ kind: "own", chart: BAR });
    await savedPanelsCall("DELETE", `/${sp}`, owner.token);
    const after = await dashboardsCall("GET", `/${dash}`, owner.token);
    expect(after.body.panels[0]).toMatchObject({ state: "ok", chart: BAR });
  });

  it("takes the saved panel's name as the title when the panel had none", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const sp = await savedPanelOf(owner.token, sq, { name: "Library name" });
    const dash = await dashboardOf(owner.token);
    const added = await dashboardsCall("POST", `/${dash}/panels`, owner.token, {
      kind: "linked",
      saved_panel_id: sp,
    });
    const res = await detachPanel(owner.token, dash, added.body.id);
    expect(res.body.title).toBe("Library name");
  });

  it("refuses an own panel", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const dash = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const read = await dashboardsCall("GET", `/${dash}`, owner.token);
    const res = await detachPanel(owner.token, dash, read.body.panels[0].id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
  });

  it("refuses a panel whose saved panel is no longer shared, and one whose saved panel is gone", async () => {
    const owner = await user();
    const dashOwner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    await prisma.savedQuery.update({
      where: { id: sq },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    const sp = await savedPanelOf(owner.token, sq);
    await shareSavedPanelDirectly(sp, dashOwner.principal, owner.id);
    const dash = await dashboardOf(dashOwner.token);
    const added = await dashboardsCall(
      "POST",
      `/${dash}/panels`,
      dashOwner.token,
      { kind: "linked", saved_panel_id: sp }
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    await savedPanelsCall("PUT", `/${sp}/shares`, owner.token, {
      principals: [],
    });
    const notShared = await detachPanel(dashOwner.token, dash, added.body.id);
    expect(notShared.status).toBe(400);
    expect(notShared.body.error).toBe("invalid_panel");
    await savedPanelsCall("DELETE", `/${sp}`, owner.token);
    const gone = await detachPanel(dashOwner.token, dash, added.body.id);
    expect(gone.status).toBe(400);
    expect(gone.body.error).toBe("invalid_panel");
  });

  it("is for the dashboard's owner: anyone else gets 404", async () => {
    const owner = await user();
    const other = await user();
    const { dash, panel } = await linked(owner);
    expect((await detachPanel(other.token, dash, panel)).status).toBe(404);
  });
});
