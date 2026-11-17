// @module-tag int
// @module-tag platform
import { decidePanels, decideSavedPanel } from "../../dashboards/decide.js";
import { clearTestGroups, setTestGroups } from "../support/principals.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeSources } from "../support/sources.js";
import { db, prisma } from "../../utils/db/index.js";
import { panelView } from "../../views/panel.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
import {
  dashboardWith,
  removeDashboardsOf,
  savedPanelRow,
  savedQueryRow,
  viewer,
} from "../support/panelDecisions.js";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

const NO_ACCESS =
  "You need expanded permissions to run this saved query. Ask an admin to extend your access.";
const QUERY_DELETED = "This panel's saved query was deleted.";
const PANEL_DELETED = "This panel's saved panel was deleted.";
const NOT_AVAILABLE = "This saved query is no longer available for dashboards.";
const NOT_SHARED =
  "This saved panel is no longer shared with this dashboard's owner.";
const NEEDS_UPDATE = "This panel needs updating by its owner.";

const QUERY = { from: "orders", select: ["id", "status", "total"] };
const CHART = { type: "bar", version: 1, x: "status", y: ["total"] };

describe("decidePanels", () => {
  let source: SeededSource;
  const owner = newQueryUser();
  const third = newQueryUser();
  /** Granted every column of orders. */
  const full = newQueryUser();
  /** Granted orders without created_at. */
  const noTime = newQueryUser();
  /** Granted only orders.id. */
  const narrow = newQueryUser();
  const owners = [owner.id, third.id];

  const one = async (
    dashboard: Awaited<ReturnType<typeof dashboardWith>>,
    as: string,
    timeRange: Parameters<typeof decidePanels>[2] = "last_30_days"
  ) => {
    const decisions = await decidePanels(viewer(as), dashboard, timeRange);
    const panel = dashboard.panels[0]!;
    return {
      decision: decisions.get(panel.id)!,
      view: panelView(panel, decisions.get(panel.id)!),
    };
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "decide");
    for (const u of [owner, third, full]) {
      await grantTo(u.principal, source.tables.orders!, "all");
    }
    await grantTo(noTime.principal, source.tables.orders!, [
      "id",
      "status",
      "total",
    ]);
    await grantTo(narrow.principal, source.tables.orders!, ["id"]);
  });
  afterAll(async () => {
    await removeDashboardsOf(owners);
    await removeSources([source.id]);
    await clearTestGroups(owner.id);
  });

  it("is ok for a viewer who can run it, with the chart, time column and saved query id", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      {
        kind: "own",
        savedQueryId: sq.id,
        chart: CHART,
        timeColumn: "created_at",
        title: "Mine",
      },
    ]);
    const { decision, view } = await one(dash, full.id);
    expect(decision.state).toBe("ok");
    expect(view).toEqual({
      id: dash.panels[0]!.id,
      kind: "own",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      title: "Mine",
      state: "ok",
      chart: CHART,
      time_column: "created_at",
      saved_query_id: sq.id,
    });
  });

  it("titles a panel with no title of its own after its saved query", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    const { view } = await one(dash, full.id);
    expect(view.title).toBe(sq.name);
    expect(view).not.toHaveProperty("time_column");
  });

  it("is saved_query_deleted for an own panel whose saved query was deleted", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    await prisma.savedQuery.delete({ where: { id: sq.id } });
    const fresh = (await db.dashboards.findWithPanels(dash.id))!;
    const { view } = await one(fresh, full.id);
    expect(view.state).toBe("saved_query_deleted");
    expect(view.message).toBe(QUERY_DELETED);
    for (const key of [
      "chart",
      "time_column",
      "saved_query_id",
      "saved_panel_id",
      "problems",
    ]) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it("is saved_panel_deleted for a linked panel whose saved panel was deleted", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const sp = await savedPanelRow(owner.id, sq.id, CHART);
    const dash = await dashboardWith(owner.id, [
      { kind: "linked", savedPanelId: sp.id },
    ]);
    await prisma.savedPanel.delete({ where: { id: sp.id } });
    const fresh = (await db.dashboards.findWithPanels(dash.id))!;
    const { view } = await one(fresh, owner.id);
    expect(view.state).toBe("saved_panel_deleted");
    expect(view.message).toBe(PANEL_DELETED);
    expect(view).not.toHaveProperty("saved_panel_id");
  });

  it("is saved_query_deleted for a linked panel whose saved panel's saved query was deleted", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const sp = await savedPanelRow(owner.id, sq.id, CHART);
    const dash = await dashboardWith(owner.id, [
      { kind: "linked", savedPanelId: sp.id },
    ]);
    await prisma.savedQuery.delete({ where: { id: sq.id } });
    const { view } = await one(dash, full.id);
    expect(view.state).toBe("saved_query_deleted");
    expect(view.message).toBe(QUERY_DELETED);
  });

  it("is ok for a linked panel the dashboard's owner owns, titled after the saved panel", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const sp = await savedPanelRow(owner.id, sq.id, CHART, "created_at");
    const dash = await dashboardWith(owner.id, [
      { kind: "linked", savedPanelId: sp.id },
    ]);
    const { view } = await one(dash, full.id);
    expect(view).toMatchObject({
      state: "ok",
      title: sp.name,
      chart: CHART,
      time_column: "created_at",
      saved_query_id: sq.id,
      saved_panel_id: sp.id,
    });
  });

  it("is not_available for a saved panel not shared with the dashboard's owner, and ok once shared with a group of theirs", async () => {
    const sq = await savedQueryRow(third.id, source, QUERY, {
      availableForDashboards: true,
      availableOrganizationId: null,
    });
    const sp = await savedPanelRow(third.id, sq.id, CHART);
    const dash = await dashboardWith(owner.id, [
      { kind: "linked", savedPanelId: sp.id },
    ]);
    const before = await one(dash, full.id);
    expect(before.view.state).toBe("not_available");
    expect(before.view.message).toBe(NOT_SHARED);
    expect(before.view).not.toHaveProperty("chart");

    const group = randomUUID();
    await setTestGroups(owner.id, [{ id: group, organizationId: null }]);
    await db.savedPanels.replaceShares(
      prisma,
      sp.id,
      [{ type: "group", id: group }],
      third.id
    );
    expect((await one(dash, full.id)).view.state).toBe("ok");
  });

  it("is not_available for a shared saved panel whose saved query is the saved panel owner's own with the toggle off", async () => {
    const otherOwner = newQueryUser();
    owners.push(otherOwner.id);
    // The saved query is the saved panel owner's own, its toggle off: it does
    // not reach the dashboard's owner, though the saved panel is shared with them.
    await grantTo(otherOwner.principal, source.tables.orders!, "all");
    const sq = await savedQueryRow(otherOwner.id, source, QUERY);
    const sp = await savedPanelRow(otherOwner.id, sq.id, CHART);
    await db.savedPanels.replaceShares(
      prisma,
      sp.id,
      [{ type: "user", id: owner.id }],
      otherOwner.id
    );
    const dash = await dashboardWith(owner.id, [
      { kind: "linked", savedPanelId: sp.id },
    ]);
    const { view } = await one(dash, full.id);
    expect(view.state).toBe("not_available");
    expect(view.message).toBe(NOT_AVAILABLE);
  });

  it("is not_available on someone else's saved query with the toggle off, and ok with it on", async () => {
    const sq = await savedQueryRow(third.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    const off = await one(dash, full.id);
    expect(off.view.state).toBe("not_available");
    expect(off.view.message).toBe(NOT_AVAILABLE);
    expect(off.view).not.toHaveProperty("saved_query_id");
    await prisma.savedQuery.update({
      where: { id: sq.id },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    expect((await one(dash, full.id)).view.state).toBe("ok");
  });

  it("is not_accessible for a viewer not granted a column, with the saved queries notice", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    const { view } = await one(dash, narrow.id);
    expect(view.state).toBe("not_accessible");
    expect(view.message).toBe(NO_ACCESS);
    for (const key of ["chart", "time_column", "saved_query_id", "problems"]) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it("is needs_update when the chart no longer fits: problems for the owner only", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const chart = { type: "bar", version: 1, x: "status", y: ["status"] };
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart },
    ]);
    const mine = await one(dash, owner.id);
    expect(mine.view.state).toBe("needs_update");
    expect(mine.view.message).toBe(NEEDS_UPDATE);
    expect(mine.view.problems).toEqual([
      { setting: "y.0", problem: "wrong_type" },
    ]);
    expect(mine.view).not.toHaveProperty("chart");
    const theirs = await one(dash, full.id);
    expect(theirs.view.state).toBe("needs_update");
    expect(theirs.view.message).toBe(NEEDS_UPDATE);
    expect(theirs.view).not.toHaveProperty("problems");
  });

  it("is not_accessible for a viewer who cannot see the time column, and needs_update for the owner when only the time column fails", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const visible = await dashboardWith(owner.id, [
      {
        kind: "own",
        savedQueryId: sq.id,
        chart: CHART,
        timeColumn: "created_at",
      },
    ]);
    const hidden = await one(visible, noTime.id);
    expect(hidden.view.state).toBe("not_accessible");
    expect(hidden.view.message).toBe(NO_ACCESS);
    // Without the time column the same viewer runs it.
    const plain = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    expect((await one(plain, noTime.id)).view.state).toBe("ok");

    const broken = await dashboardWith(owner.id, [
      {
        kind: "own",
        savedQueryId: sq.id,
        chart: CHART,
        timeColumn: "shipped_at",
      },
    ]);
    const mine = await one(broken, owner.id);
    expect(mine.view.state).toBe("needs_update");
    expect(mine.view.problems).toEqual([
      { setting: "time_column", problem: "missing_column" },
    ]);
    const theirs = await one(broken, full.id);
    expect(theirs.view.state).toBe("not_accessible");
    expect(theirs.view).not.toHaveProperty("problems");
  });

  it("checks the time column even when no time range is chosen", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      {
        kind: "own",
        savedQueryId: sq.id,
        chart: CHART,
        timeColumn: "created_at",
      },
    ]);
    expect((await one(dash, noTime.id, null)).view.state).toBe(
      "not_accessible"
    );
    expect((await one(dash, full.id, null)).view.state).toBe("ok");
  });

  it("loads the viewer's access once and each source's catalogue once for many panels", async () => {
    const a = await savedQueryRow(owner.id, source, QUERY);
    const b = await savedQueryRow(owner.id, source, QUERY);
    const sp = await savedPanelRow(owner.id, b.id, CHART);
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: a.id, chart: CHART },
      {
        kind: "own",
        savedQueryId: b.id,
        chart: CHART,
        timeColumn: "created_at",
      },
      { kind: "linked", savedPanelId: sp.id },
    ]);
    const load = vi.spyOn(db.catalog, "loadSourceCatalog");
    try {
      const decisions = await decidePanels(viewer(narrow.id), dash, "today");
      expect(load).toHaveBeenCalledTimes(1);
      expect([...decisions.values()].map((d) => d.state)).toEqual([
        "not_accessible",
        "not_accessible",
        "not_accessible",
      ]);
    } finally {
      load.mockRestore();
    }
  });
});

describe("decideSavedPanel", () => {
  let source: SeededSource;
  const owner = newQueryUser();
  const narrow = newQueryUser();

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "decidesp");
    await grantTo(owner.principal, source.tables.orders!, "all");
    await grantTo(narrow.principal, source.tables.orders!, ["id"]);
  });
  afterAll(async () => {
    await removeDashboardsOf([owner.id]);
    await removeSources([source.id]);
  });

  it("decides a saved panel on its own: ok, problems for its owner, not_accessible for a narrow viewer", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const fits = await savedPanelRow(owner.id, sq.id, CHART, "created_at");
    expect((await decideSavedPanel(viewer(owner.id), fits, null)).state).toBe(
      "ok"
    );
    expect((await decideSavedPanel(viewer(narrow.id), fits, null)).state).toBe(
      "not_accessible"
    );

    const broken = await savedPanelRow(owner.id, sq.id, {
      ...CHART,
      x: "gone",
    });
    expect(
      await decideSavedPanel(viewer(owner.id), broken, null)
    ).toMatchObject({
      state: "needs_update",
      problems: [{ setting: "x", problem: "missing_column" }],
    });
    await prisma.savedQuery.delete({ where: { id: sq.id } });
    const orphan = (await db.savedPanels.findById(fits.id))!;
    expect((await decideSavedPanel(viewer(owner.id), orphan, null)).state).toBe(
      "saved_query_deleted"
    );
  });
});
