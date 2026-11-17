// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../support/sources.js";
import { tokenFor } from "../../../support/tokens.js";
import { ENGINES } from "../../../support/engines.js";
import {
  DASHBOARDS_READ,
  DATA_READ,
} from "../../../../definitions/tereoDeclaration.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../support/savedQueries.js";
import {
  TABLE,
  chartedQuery,
  createDashboard,
  dashboardOf,
  dashboardsCall,
  ownPanel,
  shareDashboardDirectly,
} from "../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("/v1/dashboards", () => {
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
    source = await seedQuerySource(ENGINES[0]!, {}, "dashboards");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("creates a dashboard with two panels, placed without overlap", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const res = await createDashboard(owner.token, {
      name: uniqueName("dash"),
      description: "Sales",
      time_range: "last_7_days",
      refresh_seconds: 60,
      theme: "dark",
      panels: [
        ownPanel(sq),
        ownPanel(sq, { title: "Second" }),
        ownPanel(sq, { chart: TABLE }),
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      description: "Sales",
      owner: { id: owner.id },
      time_range: "last_7_days",
      refresh_seconds: 60,
      theme: "dark",
    });
    const cells = res.body.panels.map(
      (p: { x: number; y: number; w: number; h: number }) => [
        p.x,
        p.y,
        p.w,
        p.h,
      ]
    );
    expect(cells).toEqual([
      [0, 0, 6, 4],
      [6, 0, 6, 4],
      [0, 4, 12, 4],
    ]);
    expect(
      res.body.panels.map((p: { state: string; chart: { type: string } }) => [
        p.state,
        p.chart.type,
      ])
    ).toEqual([
      ["ok", "bar"],
      ["ok", "bar"],
      ["ok", "table"],
    ]);
    expect(res.body.panels[1].title).toBe("Second");
    expect(res.body.panels[0]).toMatchObject({ saved_query_id: sq });
  });

  it("defaults the fields of a dashboard with no panels", async () => {
    const owner = await user();
    const res = await createDashboard(owner.token, { name: uniqueName() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      description: "",
      time_range: null,
      refresh_seconds: null,
      theme: "auto",
      panels: [],
    });
  });

  it("lists what the caller owns and what is shared with them", async () => {
    const owner = await user();
    const recipient = await user();
    const mine = await dashboardOf(owner.token);
    const theirs = await dashboardOf(recipient.token);
    await shareDashboardDirectly(mine, recipient.principal, owner.id);
    const ids = (r: { body: { data: Array<{ id: string }> } }) =>
      r.body.data.map((d) => d.id);
    expect(ids(await dashboardsCall("GET", "", owner.token))).toEqual([mine]);
    expect(
      ids(await dashboardsCall("GET", "?scope=shared", recipient.token))
    ).toEqual([mine]);
    expect(ids(await dashboardsCall("GET", "", recipient.token))).toEqual([
      theirs,
    ]);
    const page = await dashboardsCall("GET", "?scope=shared", recipient.token);
    expect(page.body.data[0]).toMatchObject({
      id: mine,
      shared_at: expect.any(String),
    });
    expect(page.body.data[0]).not.toHaveProperty("share_count");
    const own = await dashboardsCall("GET", "", owner.token);
    expect(own.body.data[0]).toMatchObject({ share_count: 1 });
  });

  it("pages and filters by name", async () => {
    const owner = await user();
    const a = await dashboardOf(owner.token, { name: uniqueName("alpha") });
    const b = await dashboardOf(owner.token, { name: uniqueName("beta") });
    const first = await dashboardsCall("GET", "?limit=1", owner.token);
    expect(first.body.data.map((d: { id: string }) => d.id)).toEqual([b]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await dashboardsCall(
      "GET",
      `?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      owner.token
    );
    expect(second.body.data.map((d: { id: string }) => d.id)).toEqual([a]);
    const found = await dashboardsCall("GET", "?q=ALPHA", owner.token);
    expect(found.body.data.map((d: { id: string }) => d.id)).toEqual([a]);
  });

  it("answers scope=all with 403 without zeteo.dashboards.read, and lists everything with it", async () => {
    const owner = await user();
    const id = await dashboardOf(owner.token);
    expect(
      (await dashboardsCall("GET", "?scope=all", owner.token)).status
    ).toBe(403);
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    const all = await dashboardsCall("GET", "?scope=all", admin);
    expect(all.status).toBe(200);
    expect(all.body.data.map((d: { id: string }) => d.id)).toContain(id);
  });

  it("refuses a second dashboard with the same name, whatever the case", async () => {
    const owner = await user();
    const name = uniqueName("Same");
    await dashboardOf(owner.token, { name });
    const res = await createDashboard(owner.token, {
      name: name.toUpperCase(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  it("refuses a refresh interval under the minimum, and takes null", async () => {
    const owner = await user();
    const low = await createDashboard(owner.token, {
      name: uniqueName(),
      refresh_seconds: 30,
    });
    expect(low.status).toBe(400);
    expect(low.body.error).toBe("invalid_request");
    const none = await createDashboard(owner.token, {
      name: uniqueName(),
      refresh_seconds: null,
    });
    expect(none.status).toBe(201);
  });

  it("creates nothing when a panel is refused", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const name = uniqueName();
    const res = await createDashboard(owner.token, {
      name,
      panels: [
        ownPanel(sq, {
          chart: { type: "bar", version: 1, x: "nope", y: ["total"] },
        }),
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
    expect(res.body.problems).toEqual([
      { setting: "x", problem: "missing_column" },
    ]);
    const listed = await dashboardsCall(
      "GET",
      `?q=${encodeURIComponent(name)}`,
      owner.token
    );
    expect(listed.body.data).toEqual([]);
  });
});
