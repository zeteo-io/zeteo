// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { db, prisma } from "../../../../../../utils/db/index.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  savedPanelRow,
  savedQueryRow,
} from "../../../../../support/panelDecisions.js";
import {
  savedQueryOf,
  shareDirectly,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  BAR,
  TABLE,
  addPanel,
  chartedQuery,
  dashboardOf,
  dashboardsCall,
  ownPanel,
  shareDashboardDirectly,
} from "../../../../../support/dashboards.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/dashboards/:dashboardId/panels", () => {
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
    source = await seedQuerySource(ENGINES[0]!, {}, "dashpanels");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("adds an own panel into the first free cell and answers the panel", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token);
    const first = await addPanel(owner.token, id, ownPanel(sq));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      kind: "own",
      state: "ok",
      chart: BAR,
      x: 0,
      y: 0,
      w: 6,
      h: 4,
    });
    const second = await addPanel(owner.token, id, ownPanel(sq));
    expect([second.body.x, second.body.y]).toEqual([6, 0]);
    const wide = await addPanel(
      owner.token,
      id,
      ownPanel(sq, { chart: TABLE })
    );
    expect([wide.body.x, wide.body.y, wide.body.w]).toEqual([0, 4, 12]);
    const given = await addPanel(
      owner.token,
      id,
      ownPanel(sq, { x: 3, y: 20, w: 2, h: 1, title: "Mine" })
    );
    expect(given.body).toMatchObject({
      x: 3,
      y: 20,
      w: 2,
      h: 1,
      title: "Mine",
    });
    const whole = await dashboardsCall("GET", `/${id}`, owner.token);
    expect(whole.body.panels).toHaveLength(4);
  });

  it("refuses a chart naming a missing column with the problems", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token);
    const res = await addPanel(
      owner.token,
      id,
      ownPanel(sq, {
        chart: { type: "bar", version: 1, x: "nope", y: ["total"] },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
    expect(res.body.problems).toEqual([
      { setting: "x", problem: "missing_column" },
    ]);
    const wrong = await addPanel(
      owner.token,
      id,
      ownPanel(sq, {
        chart: { type: "bar", version: 1, x: "status", y: ["status"] },
      })
    );
    expect(wrong.body.problems).toEqual([
      { setting: "y.0", problem: "wrong_type" },
    ]);
  });

  it("refuses a time column the query does not have", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token);
    const res = await addPanel(
      owner.token,
      id,
      ownPanel(sq, { time_column: "nope" })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
    expect(res.body.problems).toEqual([
      { setting: "time_column", problem: "missing_column" },
    ]);
  });

  it("accepts a time column the query has", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: {
        source: source.slug,
        from: "orders",
        select: ["id", "status", "total", "created_at"],
      },
    });
    const id = await dashboardOf(owner.token, { time_range: "last_7_days" });
    const res = await addPanel(
      owner.token,
      id,
      ownPanel(sq, { time_column: "created_at" })
    );
    expect(res.status).toBe(201);
    expect(res.body.time_column).toBe("created_at");
  });

  it("is a 404 for a saved query that is neither the caller's, shared, nor available", async () => {
    const owner = await user();
    const other = await user();
    const sq = await savedQuery(other.token);
    const id = await dashboardOf(owner.token);
    const res = await addPanel(owner.token, id, ownPanel(sq));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("is a 403 for a saved query the caller sees but cannot run", async () => {
    const owner = await user();
    const narrow = await userWithOrders(source, ["id"]);
    users.push(narrow.id);
    const sq = await savedQuery(owner.token);
    await prisma.savedQuery.update({
      where: { id: sq },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    const id = await dashboardOf(narrow.token);
    const res = await addPanel(narrow.token, id, ownPanel(sq));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("saved_query_not_accessible");
  });

  it("refuses a shared saved query that is not available for dashboards", async () => {
    const owner = await user();
    const recipient = await user();
    const sq = await savedQuery(owner.token);
    await shareDirectly(sq, recipient.principal, owner.id);
    const id = await dashboardOf(recipient.token);
    const res = await addPanel(recipient.token, id, ownPanel(sq));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
    expect(res.body.problems).toEqual([
      { setting: "saved_query", problem: "not_available" },
    ]);
    await prisma.savedQuery.update({
      where: { id: sq },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    expect((await addPanel(recipient.token, id, ownPanel(sq))).status).toBe(
      201
    );
  });

  it("is a 404 to a recipient of the dashboard, and to a stranger", async () => {
    const owner = await user();
    const recipient = await user();
    const stranger = await user();
    const sq = await savedQuery(owner.token);
    const id = await dashboardOf(owner.token);
    await shareDashboardDirectly(id, recipient.principal, owner.id);
    expect((await addPanel(recipient.token, id, ownPanel(sq))).status).toBe(
      404
    );
    expect((await addPanel(stranger.token, id, ownPanel(sq))).status).toBe(404);
  });

  describe("a linked panel", () => {
    const linkedBody = (savedPanelId: string, fields = {}) => ({
      kind: "linked",
      saved_panel_id: savedPanelId,
      ...fields,
    });

    it("links the caller's own saved panel, sized by its chart type", async () => {
      const owner = await user();
      const sq = await db.savedQueries.create({
        ownerId: owner.id,
        sourceId: source.id,
        name: `q ${owner.id}`,
        description: "",
        query: chartedQuery(source),
      });
      const sp = await savedPanelRow(owner.id, sq.id, BAR);
      const id = await dashboardOf(owner.token);
      const res = await addPanel(owner.token, id, linkedBody(sp.id));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: "linked",
        state: "ok",
        saved_panel_id: sp.id,
        saved_query_id: sq.id,
        title: sp.name,
        w: 6,
        h: 4,
      });
    });

    it("is a 404 for a saved panel that is not the caller's or shared with them", async () => {
      const owner = await user();
      const other = await user();
      const sq = await savedQueryRow(other.id, source, chartedQuery(source));
      const sp = await savedPanelRow(other.id, sq.id, BAR);
      const id = await dashboardOf(owner.token);
      const res = await addPanel(owner.token, id, linkedBody(sp.id));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("links a shared saved panel only while its saved query is available", async () => {
      const owner = await user();
      const other = await user();
      const sq = await savedQueryRow(
        other.id,
        source,
        { from: "orders", select: ["id", "status", "total"] },
        { availableForDashboards: false }
      );
      const sp = await savedPanelRow(other.id, sq.id, BAR);
      await prisma.savedPanelShare.create({
        data: {
          savedPanelId: sp.id,
          principalType: "user",
          principalId: owner.id,
          createdBy: other.id,
        },
      });
      const id = await dashboardOf(owner.token);
      const refused = await addPanel(owner.token, id, linkedBody(sp.id));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("invalid_panel");
      expect(refused.body.problems).toEqual([
        { setting: "saved_panel", problem: "not_available" },
      ]);
      await prisma.savedQuery.update({
        where: { id: sq.id },
        data: { availableForDashboards: true, availableOrganizationId: null },
      });
      const linked = await addPanel(owner.token, id, linkedBody(sp.id));
      expect(linked.status).toBe(201);
      expect(linked.body.state).toBe("ok");
    });

    it("refuses a saved panel whose saved query was deleted", async () => {
      const owner = await user();
      const sp = await savedPanelRow(owner.id, null, BAR);
      const id = await dashboardOf(owner.token);
      const res = await addPanel(owner.token, id, linkedBody(sp.id));
      expect(res.status).toBe(400);
      expect(res.body.problems).toEqual([
        { setting: "saved_panel", problem: "not_available" },
      ]);
    });
  });

  it("is a 403 for the caller's own saved query when their grants fall short", async () => {
    // Their own saved query, written directly: they hold too few columns to run it.
    const none = newQueryUser();
    users.push(none.id);
    const sq = await savedQueryRow(none.id, source, chartedQuery(source));
    await grantTo(none.principal, source.tables.orders!, ["id"]);
    const id = await dashboardOf(none.token);
    const res = await addPanel(none.token, id, ownPanel(sq.id));
    expect(res.status).toBe(403);
  });
});
