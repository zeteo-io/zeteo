// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../../support/panelDecisions.js";
import { removeSources } from "../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../../../../support/engines.js";
import {
  savedQueryOf,
  userWithOrders,
} from "../../../../../../support/savedQueries.js";
import {
  TABLE,
  addPanel,
  chartedQuery,
  dashboardOf,
  dashboardsCall,
  ownPanel,
  shareDashboardDirectly,
} from "../../../../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../../support/queries.js";

describe("/v1/dashboards/:dashboardId/panels/:panelId", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };
  const savedQuery = (token: string) =>
    savedQueryOf(token, source, { query: chartedQuery(source) });
  /** A dashboard with one panel, as `{ owner, id, panel }`. */
  const withPanel = async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token);
    const panel = (await addPanel(owner.token, id, ownPanel(sq))).body;
    return { owner, sq, id, panel };
  };
  const path = (id: string, panelId: string) => `/${id}/panels/${panelId}`;

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashpanel");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("changes the title and the place", async () => {
    const { owner, id, panel } = await withPanel();
    const res = await dashboardsCall("PATCH", path(id, panel.id), owner.token, {
      title: "Revenue",
      x: 2,
      y: 5,
      w: 4,
      h: 3,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: panel.id,
      title: "Revenue",
      x: 2,
      y: 5,
      w: 4,
      h: 3,
      state: "ok",
    });
    const cleared = await dashboardsCall(
      "PATCH",
      path(id, panel.id),
      owner.token,
      {
        title: null,
      }
    );
    expect(cleared.body.title).not.toBe("Revenue");
  });

  it("keeps the saved query within the grid and replaces the chart after checking it", async () => {
    const { owner, id, panel } = await withPanel();
    const bad = await dashboardsCall("PATCH", path(id, panel.id), owner.token, {
      chart: { type: "bar", version: 1, x: "nope", y: ["total"] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_panel");
    const good = await dashboardsCall(
      "PATCH",
      path(id, panel.id),
      owner.token,
      {
        chart: TABLE,
      }
    );
    expect(good.status).toBe(200);
    expect(good.body.chart).toEqual(TABLE);
    const stale = await dashboardsCall(
      "PATCH",
      path(id, panel.id),
      owner.token,
      {
        time_column: "nope",
      }
    );
    expect(stale.body.problems).toEqual([
      { setting: "time_column", problem: "missing_column" },
    ]);
  });

  it("is a 404 to a recipient and for a panel of another dashboard", async () => {
    const { owner, id, panel } = await withPanel();
    const recipient = await user();
    await shareDashboardDirectly(id, recipient.principal, owner.id);
    expect(
      (
        await dashboardsCall("PATCH", path(id, panel.id), recipient.token, {
          title: "x",
        })
      ).status
    ).toBe(404);
    expect(
      (await dashboardsCall("DELETE", path(id, panel.id), recipient.token))
        .status
    ).toBe(404);
    const other = await dashboardOf(owner.token);
    expect(
      (await dashboardsCall("DELETE", path(other, panel.id), owner.token))
        .status
    ).toBe(404);
  });

  it("removes a panel", async () => {
    const { owner, id, panel } = await withPanel();
    expect(
      (await dashboardsCall("DELETE", path(id, panel.id), owner.token)).status
    ).toBe(204);
    const seen = await dashboardsCall("GET", `/${id}`, owner.token);
    expect(seen.body.panels).toEqual([]);
    expect(
      (await dashboardsCall("DELETE", path(id, panel.id), owner.token)).status
    ).toBe(404);
  });
});
