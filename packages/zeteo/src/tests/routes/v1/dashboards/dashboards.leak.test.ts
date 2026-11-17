// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { grantTo, newQueryUser } from "../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, prisma } from "../../../../utils/db/index.js";
import { tokenFor } from "../../../support/tokens.js";
import {
  causeQueryOn,
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
} from "../../../support/savedQueryCauses.js";
import {
  dashboardWith,
  removeDashboardsOf,
  savedPanelRow,
  savedQueryRow,
} from "../../../support/panelDecisions.js";
import {
  dashboardsCall,
  shareDashboardDirectly,
} from "../../../support/dashboards.js";

// A recipient who cannot run a panel learns nothing of why: the seven causes
// look the same over HTTP, and a saved query of a third party is not named.

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

const strippedPanel = (panel: Record<string, unknown>) => {
  const { id: _i, title: _t, x: _x, y: _y, w: _w, h: _h, ...rest } = panel;
  return rest;
};

describe("a recipient's GET of a dashboard: causes of no access look the same", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "dashleak");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeDashboardsOf([sources.owner.id]);
    await removeNoAccessCases(sources, users);
  });

  it("answers the same body for each of the seven causes, with no chart, time column or ids", async () => {
    const cases: Array<{
      cause: string;
      savedQueryId: string;
      viewerId: string;
      token: string;
    }> = (await setUpNoAccessCases(sources, sources.owner)).map((c) => ({
      cause: c.cause,
      savedQueryId: c.id,
      viewerId: c.recipient.id,
      token: c.recipient.token,
    }));
    // 7. a time column the viewer cannot see
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
      token: noTime.token,
    });

    const seen: Array<{ cause: string; panel: unknown; raw: string }> = [];
    for (const { cause, savedQueryId, viewerId, token } of cases) {
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
      await shareDashboardDirectly(
        dash.id,
        { type: "user", id: viewerId },
        sources.owner.id
      );
      const res = await dashboardsCall("GET", `/${dash.id}`, token);
      expect(res.status, cause).toBe(200);
      const panel = res.body.panels[0] as Record<string, unknown>;
      expect(panel.state, cause).toBe("not_accessible");
      for (const key of [
        "chart",
        "time_column",
        "saved_query_id",
        "saved_panel_id",
        "problems",
      ]) {
        expect(panel, cause).not.toHaveProperty(key);
      }
      seen.push({
        cause,
        panel: strippedPanel(panel),
        raw: JSON.stringify(res.body.panels),
      });
    }
    expect(seen).toHaveLength(7);
    for (const s of seen) {
      expect(s.panel, s.cause).toEqual(seen[0]!.panel);
      for (const name of FIXTURE_NAMES)
        expect(s.raw, s.cause).not.toContain(name);
      for (const on of [sources.source, sources.archived, sources.missing]) {
        expect(s.raw, s.cause).not.toContain(on.slug);
      }
    }
  });
});

describe("a third party's saved query is not named to a viewer", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];
  const org = "11111111-1111-4111-8111-111111111111";

  beforeAll(async () => {
    sources = await seedCauseSources({}, "dashnamed");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeNoAccessCases(sources, users);
  });

  const setup = async (title: string | null) => {
    const dashOwner = newQueryUser();
    const viewer = newQueryUser();
    users.push(dashOwner.id, viewer.id);
    const third = sources.owner;
    const query = await savedQueryRow(
      third.id,
      sources.source,
      causeQueryOn(sources.source),
      {
        availableForDashboards: true,
        availableOrganizationId: null,
      }
    );
    const dash = await dashboardWith(dashOwner.id, [
      {
        kind: "own",
        savedQueryId: query.id,
        chart: CHART,
        ...(title && { title }),
      },
    ]);
    await shareDashboardDirectly(
      dash.id,
      { type: "user", id: viewer.id },
      dashOwner.id
    );
    // The third party withdraws it: the panel is not available.
    await prisma.savedQuery.update({
      where: { id: query.id },
      data: { availableForDashboards: false },
    });
    const res = await dashboardsCall("GET", `/${dash.id}`, viewer.token);
    return { res, query, dashOwner, viewer };
  };

  it("shows 'Untitled panel' for a not available panel with no title of its own", async () => {
    const { res, query } = await setup(null);
    expect(res.status).toBe(200);
    expect(res.body.panels[0]).toMatchObject({
      state: "not_available",
      title: "Untitled panel",
    });
    expect(JSON.stringify(res.body)).not.toContain(query.name);
  });

  it("shows the panel's own title when it has one", async () => {
    const { res, query } = await setup("My revenue");
    expect(res.body.panels[0]).toMatchObject({
      state: "not_available",
      title: "My revenue",
    });
    expect(JSON.stringify(res.body)).not.toContain(query.name);
  });

  it("does not name a third party's saved panel either, for a viewer in another organization", async () => {
    const dashOwner = newQueryUser();
    const viewer = newQueryUser();
    users.push(dashOwner.id, viewer.id);
    const third = sources.owner;
    const query = await savedQueryRow(
      third.id,
      sources.source,
      causeQueryOn(sources.source),
      {
        availableForDashboards: true,
        availableOrganizationId: org,
      }
    );
    const savedPanel = await savedPanelRow(third.id, query.id, CHART);
    await prisma.savedPanelShare.create({
      data: {
        savedPanelId: savedPanel.id,
        principalType: "user",
        principalId: dashOwner.id,
        createdBy: third.id,
      },
    });
    const dash = await dashboardWith(dashOwner.id, [
      { kind: "linked", savedPanelId: savedPanel.id },
    ]);
    await shareDashboardDirectly(
      dash.id,
      { type: "user", id: viewer.id },
      dashOwner.id
    );
    // The viewer is signed in to another organization than the toggle's.
    const token = tokenFor({
      userId: viewer.id,
      permissions: [DATA_READ],
      org: "22222222-2222-4222-8222-222222222222",
    });
    const res = await dashboardsCall("GET", `/${dash.id}`, token);
    expect(res.body.panels[0]).toMatchObject({
      state: "not_available",
      title: "Untitled panel",
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(savedPanel.name);
    expect(raw).not.toContain(query.name);
  });
});
