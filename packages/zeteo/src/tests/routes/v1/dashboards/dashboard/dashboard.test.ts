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
  BAR,
  TABLE,
  chartedQuery,
  dashboardOf,
  dashboardsCall,
  ownPanel,
  shareDashboardDirectly,
} from "../../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../support/queries.js";

describe("/v1/dashboards/:dashboardId", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };
  const savedQuery = (token: string) =>
    savedQueryOf(token, source, { query: chartedQuery(source) });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashboard");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("shows a recipient the dashboard with its ok panels and their chart settings, not the share list", async () => {
    const owner = await user();
    const recipient = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    await shareDashboardDirectly(id, recipient.principal, owner.id);
    const res = await dashboardsCall("GET", `/${id}`, recipient.token);
    expect(res.status).toBe(200);
    expect(res.body.owner.id).toBe(owner.id);
    expect(res.body.shared_at).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty("share_count");
    expect(res.body.panels).toEqual([
      expect.objectContaining({
        kind: "own",
        state: "ok",
        chart: BAR,
        saved_query_id: sq,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
      }),
    ]);
    const own = await dashboardsCall("GET", `/${id}`, owner.token);
    expect(own.body.share_count).toBe(1);
  });

  it("is a 404 to a stranger, and readable by zeteo.dashboards.read", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await dashboardOf(owner.token);
    expect((await dashboardsCall("GET", `/${id}`, stranger.token)).status).toBe(
      404
    );
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    expect((await dashboardsCall("GET", `/${id}`, admin)).status).toBe(200);
  });

  it("is a 404 for a dashboard that does not exist", async () => {
    const owner = await user();
    const res = await dashboardsCall(
      "GET",
      "/00000000-0000-4000-8000-000000000000",
      owner.token
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("lets the owner change the fields, and nobody else", async () => {
    const owner = await user();
    const recipient = await user();
    const id = await dashboardOf(owner.token);
    await shareDashboardDirectly(id, recipient.principal, owner.id);
    const res = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      name: "Renamed",
      description: "d",
      time_range: "this_month",
      refresh_seconds: 120,
      theme: "light",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Renamed",
      description: "d",
      time_range: "this_month",
      refresh_seconds: 120,
      theme: "light",
    });
    const cleared = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      time_range: null,
      refresh_seconds: null,
    });
    expect(cleared.body).toMatchObject({
      time_range: null,
      refresh_seconds: null,
    });
    expect(
      (await dashboardsCall("PATCH", `/${id}`, recipient.token, { name: "x" }))
        .status
    ).toBe(404);
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_WRITE] });
    expect(
      (await dashboardsCall("PATCH", `/${id}`, admin, { name: "x" })).status
    ).toBe(404);
  });

  it("refuses a rename to a name the owner has, and an empty patch", async () => {
    const owner = await user();
    const taken = uniqueName("taken");
    await dashboardOf(owner.token, { name: taken });
    const id = await dashboardOf(owner.token);
    const clash = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      name: taken.toUpperCase(),
    });
    expect(clash.status).toBe(409);
    const empty = await dashboardsCall("PATCH", `/${id}`, owner.token, {});
    expect(empty.status).toBe(400);
  });

  it("replaces the panel list when panels are given, and keeps it otherwise", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token, {
      panels: [ownPanel(sq), ownPanel(sq)],
    });
    const renamed = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      name: uniqueName(),
    });
    expect(renamed.body.panels).toHaveLength(2);
    const replaced = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      panels: [ownPanel(sq, { chart: TABLE, x: 0, y: 2, w: 12, h: 3 })],
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.panels).toHaveLength(1);
    expect(replaced.body.panels[0]).toMatchObject({ x: 0, y: 2, w: 12, h: 3 });
    const none = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      panels: [],
    });
    expect(none.body.panels).toEqual([]);
  });

  it("changes nothing when a replacement panel is refused", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const res = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      name: "Not applied",
      panels: [
        ownPanel(sq, {
          chart: { type: "bar", version: 1, x: "nope", y: ["total"] },
        }),
      ],
    });
    expect(res.status).toBe(400);
    const still = await dashboardsCall("GET", `/${id}`, owner.token);
    expect(still.body.name).not.toBe("Not applied");
    expect(still.body.panels).toHaveLength(1);
  });

  it("saves a layout that holds a not available panel, keeping every panel's id", async () => {
    const owner = await user();
    const other = await user();
    const mine = await savedQuery(owner.token);
    const theirs = await savedQuery(other.token);
    await prisma.savedQuery.update({
      where: { id: theirs },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    const id = await dashboardOf(owner.token, {
      panels: [ownPanel(mine), ownPanel(theirs, { title: "Borrowed" })],
    });
    await prisma.savedQuery.update({
      where: { id: theirs },
      data: { availableForDashboards: false },
    });
    const before = (await dashboardsCall("GET", `/${id}`, owner.token)).body
      .panels;
    expect(before.map((p: { state: string }) => p.state)).toEqual([
      "ok",
      "not_available",
    ]);
    const res = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      panels: [
        { id: before[1].id, x: 0, y: 0, w: 12, h: 2 },
        { id: before[0].id, x: 0, y: 2, w: 6, h: 3, title: "Moved" },
      ],
    });
    expect(res.status).toBe(200);
    const after = res.body.panels;
    expect(after.map((p: { id: string }) => p.id)).toEqual([
      before[1].id,
      before[0].id,
    ]);
    expect(after[0]).toMatchObject({
      state: "not_available",
      title: "Borrowed",
      w: 12,
    });
    expect(after[1]).toMatchObject({ state: "ok", title: "Moved", y: 2 });
    // The stored settings survived: turning the toggle back on restores it.
    await prisma.savedQuery.update({
      where: { id: theirs },
      data: { availableForDashboards: true },
    });
    const back = await dashboardsCall("GET", `/${id}`, owner.token);
    expect(back.body.panels[0]).toMatchObject({ state: "ok", chart: BAR });
  });

  it("drops the panels a layout leaves out, adds new ones, and refuses an unknown or repeated id", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token, {
      panels: [ownPanel(sq), ownPanel(sq)],
    });
    const [a, b] = (await dashboardsCall("GET", `/${id}`, owner.token)).body
      .panels;
    const res = await dashboardsCall("PATCH", `/${id}`, owner.token, {
      panels: [
        { id: a.id, x: 0, y: 0, w: 6, h: 4 },
        ownPanel(sq, { chart: TABLE }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.panels).toHaveLength(2);
    expect(res.body.panels[0].id).toBe(a.id);
    expect(res.body.panels.map((p: { id: string }) => p.id)).not.toContain(
      b.id
    );
    const place = { x: 0, y: 0, w: 6, h: 4 };
    for (const panels of [
      [{ id: "00000000-0000-4000-8000-000000000000", ...place }],
      [
        { id: a.id, ...place },
        { id: a.id, ...place },
      ],
      [{ id: b.id, ...place }],
    ]) {
      const bad = await dashboardsCall("PATCH", `/${id}`, owner.token, {
        panels,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_panel");
      expect(bad.body.problems).toEqual([
        { setting: "panels", problem: "unknown_panel" },
      ]);
    }
    const still = await dashboardsCall("GET", `/${id}`, owner.token);
    expect(still.body.panels).toHaveLength(2);
  });

  it("deletes for the owner and a holder of zeteo.dashboards.write; a recipient gets a 404", async () => {
    const owner = await user();
    const recipient = await user();
    const mine = await dashboardOf(owner.token);
    const other = await dashboardOf(owner.token);
    await shareDashboardDirectly(other, recipient.principal, owner.id);
    expect(
      (await dashboardsCall("DELETE", `/${other}`, recipient.token)).status
    ).toBe(404);
    expect(
      (await dashboardsCall("DELETE", `/${mine}`, owner.token)).status
    ).toBe(204);
    expect((await dashboardsCall("GET", `/${mine}`, owner.token)).status).toBe(
      404
    );
    const reader = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    expect((await dashboardsCall("DELETE", `/${other}`, reader)).status).toBe(
      404
    );
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_WRITE] });
    expect((await dashboardsCall("DELETE", `/${other}`, admin)).status).toBe(
      204
    );
  });
});
