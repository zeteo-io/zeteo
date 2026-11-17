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
});
