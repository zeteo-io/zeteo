// @module-tag int
// @module-tag platform
import { removeDashboardsOf, viewer } from "../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { saveFromPanel } from "../../saved-panels/service.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../support/savedQueries.js";
import {
  BAR,
  chartedQuery,
  dashboardOf,
  dashboardsCall,
  ownPanel,
} from "../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

describe("saveFromPanel", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(ENGINES[0]!, {}, "savefrompanel");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
    await stopTereo();
  });

  it("saves an own panel's saved query and chart as a saved panel of the caller's", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const dash = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const panel = (await dashboardsCall("GET", `/${dash}`, owner.token)).body
      .panels[0];
    const name = uniqueName("saved");
    const saved = await saveFromPanel(viewer(owner.id), dash, panel.id, {
      name,
    });
    expect(saved).toMatchObject({
      name,
      description: "",
      owner: { id: owner.id },
      state: "ok",
      chart: BAR,
      saved_query_id: sq,
    });
  });

  it("refuses another user's dashboard", async () => {
    const owner = await user();
    const other = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const dash = await dashboardOf(owner.token, { panels: [ownPanel(sq)] });
    const panel = (await dashboardsCall("GET", `/${dash}`, owner.token)).body
      .panels[0];
    await expect(
      saveFromPanel(viewer(other.id), dash, panel.id, { name: uniqueName() })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
