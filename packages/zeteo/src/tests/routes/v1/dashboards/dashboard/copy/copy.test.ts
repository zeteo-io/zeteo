// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  BAR,
  chartedQuery,
  dashboardOf,
  dashboardsCall,
  ownPanel,
  shareDashboardDirectly,
} from "../../../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/dashboards/:dashboardId/copy", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async (columns: string[] | "all" = "all") => {
    const u = await userWithOrders(source, columns);
    users.push(u.id);
    return u;
  };
  const copy = (id: string, token: string, body: unknown) =>
    dashboardsCall("POST", `/${id}/copy`, token, body);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashcopy");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("gives the copier their own dashboard with the same fields and panels", async () => {
    const owner = await user();
    const viewer = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await dashboardOf(owner.token, {
      description: "d",
      time_range: "last_7_days",
      refresh_seconds: 120,
      theme: "dark",
      panels: [ownPanel(sq, { title: "Revenue" })],
    });
    await shareDashboardDirectly(id, viewer.principal, owner.id);
    const name = uniqueName("copy");
    const res = await copy(id, viewer.token, { name });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name,
      description: "d",
      owner: { id: viewer.id },
      time_range: "last_7_days",
      refresh_seconds: 120,
      theme: "dark",
    });
    expect(res.body.id).not.toBe(id);
    expect(res.body.panels).toHaveLength(1);
    expect(res.body.panels[0]).toMatchObject({
      kind: "own",
      title: "Revenue",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
    });
    // The copier's own copy is decided for them: the saved query is the
    // original owner's and not available, so the panel is not available.
    expect(res.body.panels[0].state).toBe("not_available");
    expect(res.body.panels[0]).not.toHaveProperty("chart");
    // The original is untouched; the copier now owns the copy.
    const mine = await dashboardsCall("GET", "", viewer.token);
    expect(mine.body.data.map((d: { id: string }) => d.id)).toEqual([
      res.body.id,
    ]);
    expect(res.body.panels[0].id).not.toBe(
      (await dashboardsCall("GET", `/${id}`, owner.token)).body.panels[0].id
    );
  });

  it("restores the chart for a copier who may use the saved query", async () => {
    const owner = await user();
    const viewer = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    await shareDashboardDirectly(id, viewer.principal, owner.id);
    const res = await copy(id, viewer.token, { name: uniqueName() });
    // Not the viewer's saved query and not available: not_available, as above.
    expect(res.body.panels[0].state).toBe("not_available");
    // The copier of their own dashboard keeps a working copy.
    const mine = await dashboardOf(viewer.token, {
      panels: [
        ownPanel(
          await savedQueryOf(viewer.token, source, {
            query: chartedQuery(source),
          })
        ),
      ],
    });
    const own = await copy(mine, viewer.token, { name: uniqueName() });
    expect(own.body.panels[0]).toMatchObject({ state: "ok", chart: BAR });
  });

  it("is a 404 for a dashboard the caller cannot see, and a 409 for a name they have", async () => {
    const owner = await user();
    const stranger = await user();
    const id = await dashboardOf(owner.token);
    expect(
      (await copy(id, stranger.token, { name: uniqueName() })).status
    ).toBe(404);
    const name = uniqueName("taken");
    await dashboardOf(owner.token, { name });
    const clash = await copy(id, owner.token, { name: name.toUpperCase() });
    expect(clash.status).toBe(409);
  });
});
