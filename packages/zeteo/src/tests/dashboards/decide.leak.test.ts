// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grantTo, newQueryUser } from "../support/queries.js";
import { decidePanels } from "../../dashboards/decide.js";
import { panelView } from "../../views/panel.js";
import { db } from "../../utils/db/index.js";
import {
  causeQueryOn,
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
} from "../support/savedQueryCauses.js";
import {
  dashboardWith,
  removeDashboardsOf,
  viewer,
} from "../support/panelDecisions.js";

// A viewer who cannot run a panel learns nothing of why: the six saved query
// causes and a time column they cannot see give the same panel body.

const CHART = {
  type: "table",
  version: 1,
  columns: ["id", "status", "customers.region"],
};
const FIXTURE_NAMES = [
  "orders",
  "customers",
  "status",
  "region",
  "created_at",
  "total",
];

const stripped = (view: Record<string, unknown>) => {
  const { id: _i, title: _t, x: _x, y: _y, w: _w, h: _h, ...rest } = view;
  return rest;
};

describe("panel decisions: seven causes of no access look the same", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "panelleak");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeDashboardsOf([sources.owner.id]);
    await removeNoAccessCases(sources, users);
  });

  it("gives the same panel body, naming nothing of the fixture, for each cause", async () => {
    const cases: Array<{
      cause: string;
      savedQueryId: string;
      viewerId: string;
    }> = (await setUpNoAccessCases(sources, sources.owner)).map((c) => ({
      cause: c.cause,
      savedQueryId: c.id,
      viewerId: c.recipient.id,
    }));

    // 7. a time column the viewer cannot see: everything granted but orders.created_at
    const noTime = newQueryUser();
    const orders = sources.source.tables.orders!;
    await grantTo(
      noTime.principal,
      orders,
      Object.keys(orders.columns).filter((c) => c !== "created_at")
    );
    await grantTo(noTime.principal, sources.source.tables.customers!, "all");
    const own = await db.savedQueries.create({
      ownerId: sources.owner.id,
      sourceId: sources.source.id,
      name: "time leak",
      description: "",
      query: causeQueryOn(sources.source),
    });
    cases.push({
      cause: "a time column not granted",
      savedQueryId: own.id,
      viewerId: noTime.id,
    });

    const seen: Array<{ cause: string; body: unknown; raw: string }> = [];
    for (const { cause, savedQueryId, viewerId } of cases) {
      users.push(viewerId);
      const dash = await dashboardWith(sources.owner.id, [
        {
          kind: "own",
          savedQueryId,
          chart: CHART,
          timeColumn: "created_at",
          title: cause,
        },
      ]);
      const load = vi.spyOn(db.catalog, "loadSourceCatalog");
      let view: Record<string, unknown>;
      try {
        const decisions = await decidePanels(
          viewer(viewerId),
          dash,
          "last_30_days"
        );
        const panel = dash.panels[0]!;
        view = panelView(panel, decisions.get(panel.id)!) as unknown as Record<
          string,
          unknown
        >;
        // The same work whatever the cause: the source's catalogue, once.
        expect(load, cause).toHaveBeenCalledTimes(1);
      } finally {
        load.mockRestore();
      }
      expect(view.state, cause).toBe("not_accessible");
      seen.push({
        cause,
        body: stripped(view),
        raw: JSON.stringify(stripped(view)),
      });
    }

    expect(seen).toHaveLength(7);
    for (const s of seen) {
      expect(s.body, s.cause).toEqual(seen[0]!.body);
      for (const name of FIXTURE_NAMES)
        expect(s.raw, s.cause).not.toContain(name);
      for (const on of [sources.source, sources.archived, sources.missing]) {
        expect(s.raw, s.cause).not.toContain(on.slug);
      }
    }
    expect(seen[0]!.body).toEqual({
      kind: "own",
      state: "not_accessible",
      message:
        "You need expanded permissions to run this saved query. Ask an admin to extend your access.",
    });
  });

  it("keeps only the id and name of the saved query and saved panel of a panel that is not ok", async () => {
    const owner = sources.owner;
    const query = await db.savedQueries.create({
      ownerId: owner.id,
      sourceId: sources.source.id,
      name: "refs query",
      description: "private",
      query: causeQueryOn(sources.source),
    });
    const none = newQueryUser();
    users.push(none.id);
    const panel = await db.savedPanels.create({
      ownerId: owner.id,
      name: "refs panel",
      description: "",
      savedQueryId: query.id,
      chart: CHART,
      timeColumn: null,
    });
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: query.id, chart: CHART },
      { kind: "linked", savedPanelId: panel.id },
    ]);
    const decisions = await decidePanels(viewer(none.id), dash, null);
    for (const p of dash.panels) {
      const decision = decisions.get(p.id)!;
      expect(decision.state).toBe("not_accessible");
      expect(decision.savedQuery).toEqual({ id: query.id, name: "refs query" });
    }
    const linked = decisions.get(
      dash.panels.find((p) => p.kind === "linked")!.id
    )!;
    expect(linked.savedPanel).toEqual({ id: panel.id, name: "refs panel" });
  });

  it("names a not available panel's saved query only when the dashboard's owner owns it", async () => {
    const third = sources.owner;
    const dashOwner = newQueryUser();
    users.push(dashOwner.id);
    const theirs = await db.savedQueries.create({
      ownerId: third.id,
      sourceId: sources.source.id,
      name: "third party query",
      description: "",
      query: causeQueryOn(sources.source),
    });
    const dash = await dashboardWith(dashOwner.id, [
      { kind: "own", savedQueryId: theirs.id, chart: CHART },
    ]);
    const decisions = await decidePanels(viewer(dashOwner.id), dash, null);
    const decision = decisions.get(dash.panels[0]!.id)!;
    expect(decision.state).toBe("not_available");
    expect(decision.savedQuery).toBeUndefined();
    const view = panelView(dash.panels[0]!, decision);
    expect(view.title).toBe("Untitled panel");
    expect(JSON.stringify(view)).not.toContain("third party query");
    // With a title of its own, the panel shows that.
    const titled = await dashboardWith(dashOwner.id, [
      { kind: "own", savedQueryId: theirs.id, chart: CHART, title: "Mine" },
    ]);
    const again = (await decidePanels(viewer(dashOwner.id), titled, null)).get(
      titled.panels[0]!.id
    )!;
    expect(panelView(titled.panels[0]!, again).title).toBe("Mine");
  });
});
