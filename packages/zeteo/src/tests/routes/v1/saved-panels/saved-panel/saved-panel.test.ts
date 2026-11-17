// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../support/sources.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { ENGINES } from "../../../../support/engines.js";
import {
  DASHBOARDS_READ,
  DASHBOARDS_WRITE,
  DATA_READ,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
  shareSavedPanelDirectly,
} from "../../../../support/savedPanels.js";
import {
  dashboardOf,
  dashboardsCall,
  TABLE,
  chartedQuery,
} from "../../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../support/queries.js";

describe("/v1/saved-panels/:savedPanelId", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };
  const savedQuery = (token: string) =>
    savedQueryOf(token, source, { query: chartedQuery(source) });
  const link = (token: string, dashboardId: string, savedPanelId: string) =>
    dashboardsCall("POST", `/${dashboardId}/panels`, token, {
      kind: "linked",
      saved_panel_id: savedPanelId,
    });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpanel");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("shows the owner and a recipient the panel, counts of use only to the owner", async () => {
    const owner = await user();
    const recipient = await user();
    const sq = await savedQuery(owner.token);
    const id = await savedPanelOf(owner.token, sq);
    await shareSavedPanelDirectly(id, recipient.principal, owner.id);
    const dash = await dashboardOf(owner.token);
    expect((await link(owner.token, dash, id)).status).toBe(201);
    const mine = await savedPanelsCall("GET", `/${id}`, owner.token);
    expect(mine.body).toMatchObject({
      state: "ok",
      saved_query_id: sq,
      used_by: { dashboards: 1 },
    });
    const theirs = await savedPanelsCall("GET", `/${id}`, recipient.token);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toMatchObject({
      state: "ok",
      shared_at: expect.any(String),
    });
    expect(theirs.body).not.toHaveProperty("used_by");
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    const seen = await savedPanelsCall("GET", `/${id}`, admin);
    expect(seen.body.used_by).toEqual({ dashboards: 1 });
  });

  it("answers 404 to anyone it is not shared with", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await savedPanelOf(owner.token, await savedQuery(owner.token));
    expect(
      (await savedPanelsCall("GET", `/${id}`, stranger.token)).status
    ).toBe(404);
  });

  it("changes only for its owner, checking new settings", async () => {
    const owner = await user();
    const recipient = await user();
    const sq = await savedQuery(owner.token);
    const id = await savedPanelOf(owner.token, sq);
    await shareSavedPanelDirectly(id, recipient.principal, owner.id);
    expect(
      (await savedPanelsCall("PATCH", `/${id}`, recipient.token, { name: "x" }))
        .status
    ).toBe(404);
    const renamed = await savedPanelsCall("PATCH", `/${id}`, owner.token, {
      name: "Renamed",
      chart: TABLE,
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", chart: TABLE });
    const bad = await savedPanelsCall("PATCH", `/${id}`, owner.token, {
      chart: { type: "bar", version: 1, x: "nope", y: ["total"] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_panel");
    expect(
      (await savedPanelsCall("PATCH", `/${id}`, owner.token, {})).status
    ).toBe(400);
  });

  it("changes a linked panel on every dashboard that links it", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await savedPanelOf(owner.token, sq);
    const dash = await dashboardOf(owner.token);
    const panel = await link(owner.token, dash, id);
    await savedPanelsCall("PATCH", `/${id}`, owner.token, { chart: TABLE });
    const read = await dashboardsCall("GET", `/${dash}`, owner.token);
    expect(read.body.panels[0]).toMatchObject({
      id: panel.body.id,
      kind: "linked",
      state: "ok",
      chart: TABLE,
      saved_panel_id: id,
    });
  });

  it("deleting it leaves each linked panel saved_panel_deleted", async () => {
    const owner = await user();
    const id = await savedPanelOf(owner.token, await savedQuery(owner.token));
    const dash = await dashboardOf(owner.token);
    await link(owner.token, dash, id);
    expect(
      (await savedPanelsCall("DELETE", `/${id}`, owner.token)).status
    ).toBe(204);
    const read = await dashboardsCall("GET", `/${dash}`, owner.token);
    expect(read.body.panels[0]).toMatchObject({
      kind: "linked",
      state: "saved_panel_deleted",
      message: "This panel's saved panel was deleted.",
    });
    expect(read.body.panels[0]).not.toHaveProperty("chart");
    expect(read.body.panels[0]).not.toHaveProperty("saved_panel_id");
  });

  it("lets a holder of zeteo.dashboards.write delete it, and a recipient not", async () => {
    const owner = await user();
    const recipient = await user();
    const id = await savedPanelOf(owner.token, await savedQuery(owner.token));
    await shareSavedPanelDirectly(id, recipient.principal, owner.id);
    expect(
      (await savedPanelsCall("DELETE", `/${id}`, recipient.token)).status
    ).toBe(404);
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_WRITE] });
    expect((await savedPanelsCall("DELETE", `/${id}`, admin)).status).toBe(204);
  });

  it("is not_available on the dashboard once its owner unshares it from the dashboard's owner", async () => {
    const owner = await user();
    const dashOwner = await user();
    const sq = await savedQuery(owner.token);
    await prisma.savedQuery.update({
      where: { id: sq },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    const id = await savedPanelOf(owner.token, sq, { name: uniqueName("lib") });
    await shareSavedPanelDirectly(id, dashOwner.principal, owner.id);
    const dash = await dashboardOf(dashOwner.token);
    expect((await link(dashOwner.token, dash, id)).status).toBe(201);
    await savedPanelsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [],
    });
    const read = await dashboardsCall("GET", `/${dash}`, dashOwner.token);
    expect(read.body.panels[0]).toMatchObject({
      state: "not_available",
      message:
        "This saved panel is no longer shared with this dashboard's owner.",
    });
    expect(read.body.panels[0]).not.toHaveProperty("chart");
    expect(read.body.panels[0]).not.toHaveProperty("saved_panel_id");
  });
});
