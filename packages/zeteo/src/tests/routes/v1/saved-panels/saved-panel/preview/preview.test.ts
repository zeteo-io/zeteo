// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { BASE_URL, fetchJson } from "../../../../../support/http.js";
import { chartedQuery } from "../../../../../support/dashboards.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  savedQueryOf,
  shareDirectly,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
  shareSavedPanelDirectly,
} from "../../../../../support/savedPanels.js";
import {
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-panels/:savedPanelId/preview", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async (columns: string[] | "all" = "all") => {
    const u = await userWithOrders(source, columns);
    users.push(u.id);
    return u;
  };
  const preview = (id: string, token: string, body: unknown = {}) =>
    savedPanelsCall("POST", `/${id}/preview`, token, body);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpanelpreview");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("runs the saved query as the caller and records one api run against it", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await savedPanelOf(owner.token, sq);
    const res = await preview(id, owner.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "status",
      "total",
    ]);
    expect(res.body.rows.length).toBeGreaterThan(1);
    const runs = await runsOf([owner.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: res.body.run_id,
      savedQueryId: sq,
      entryPoint: "api",
      outcome: "ok",
    });
    expect(runs[0]!.dashboardId ?? null).toBeNull();
  });

  it("records every call", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await savedPanelOf(owner.token, sq);
    await preview(id, owner.token);
    await preview(id, owner.token);
    expect(await runsOf([owner.id])).toHaveLength(2);
  });

  it("applies the time range when the saved panel has a time column", async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: {
        ...chartedQuery(source),
        select: ["id", "status", "total", "created_at"],
      },
    });
    const id = await savedPanelOf(owner.token, sq, {
      time_column: "created_at",
    });
    const all = await preview(id, owner.token);
    const none = await preview(id, owner.token, {
      time_range: "last_15_minutes",
    });
    expect(all.status).toBe(200);
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(none.body.rows.length).toBeLessThan(all.body.rows.length);
    const bad = await preview(id, owner.token, { time_range: "forever" });
    expect(bad.status).toBe(400);
  });

  it("runs a shared saved panel as the recipient, and refuses what they cannot run", async () => {
    const owner = await user();
    const able = await user();
    const unable = await user(["id"]);
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await savedPanelOf(owner.token, sq);
    await shareSavedPanelDirectly(id, able.principal, owner.id);
    await shareSavedPanelDirectly(id, unable.principal, owner.id);
    expect((await preview(id, able.token)).status).toBe(200);
    const refused = await preview(id, unable.token);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("saved_query_not_accessible");
  });

  it("answers 404 for one the caller cannot see", async () => {
    const owner = await user();
    const stranger = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await savedPanelOf(owner.token, sq);
    expect((await preview(id, stranger.token)).status).toBe(404);
  });

  it("does not hand the saved query's JSON to someone it was not shared with, through their own runs", async () => {
    const owner = await user();
    const viewer = await user();
    const direct = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    // Reached through the saved panel, not shared, not available.
    const id = await savedPanelOf(owner.token, sq);
    await shareSavedPanelDirectly(id, viewer.principal, owner.id);
    await shareSavedPanelDirectly(id, direct.principal, owner.id);
    await shareDirectly(sq, direct.principal, owner.id);
    for (const u of [owner, viewer, direct]) {
      expect((await preview(id, u.token)).status).toBe(200);
    }
    const mine = (token: string) =>
      fetchJson("GET", `${BASE_URL}/v1/me/runs`, token);
    expect((await mine(viewer.token)).body.data[0].query).toEqual({
      withheld: true,
    });
    expect((await mine(owner.token)).body.data[0].query).toMatchObject({
      from: "orders",
    });
    expect((await mine(direct.token)).body.data[0].query).toMatchObject({
      from: "orders",
    });
  });
});
