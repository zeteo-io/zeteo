// @module-tag int
// @module-tag platform
import { grantTo, newQueryUser } from "../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, prisma } from "../../../../utils/db/index.js";
import {
  causeQueryOn,
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
} from "../../../support/savedQueryCauses.js";
import {
  removeDashboardsOf,
  savedPanelRow,
} from "../../../support/panelDecisions.js";
import {
  savedPanelsCall,
  shareSavedPanelDirectly,
} from "../../../support/savedPanels.js";

// A recipient who cannot run a saved panel learns nothing of why: the seven
// causes look the same over HTTP, with no chart, time column or saved query.

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

const strippedView = (view: Record<string, unknown>) => {
  const {
    id: _i,
    name: _n,
    description: _d,
    owner: _o,
    created_at: _c,
    updated_at: _u,
    shared_at: _s,
    ...rest
  } = view;
  return rest;
};

describe("a recipient's GET of a saved panel: causes of no access look the same", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];

  beforeAll(async () => {
    sources = await seedCauseSources({}, "sploak");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeNoAccessCases(sources, users);
  });

  it("answers the same view for each of the seven causes, with no chart, time column or saved query", async () => {
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

    const seen: Array<{ cause: string; view: unknown; raw: string }> = [];
    for (const { cause, savedQueryId, viewerId, token } of cases) {
      users.push(viewerId);
      const panel = await savedPanelRow(
        sources.owner.id,
        savedQueryId,
        CHART,
        "created_at"
      );
      await shareSavedPanelDirectly(
        panel.id,
        { type: "user", id: viewerId },
        sources.owner.id
      );
      const res = await savedPanelsCall("GET", `/${panel.id}`, token);
      expect(res.status, cause).toBe(200);
      expect(res.body.state, cause).toBe("not_accessible");
      for (const key of [
        "chart",
        "time_column",
        "saved_query_id",
        "problems",
        "used_by",
        "share_count",
      ]) {
        expect(res.body, cause).not.toHaveProperty(key);
      }
      seen.push({
        cause,
        view: strippedView(res.body),
        raw: JSON.stringify(strippedView(res.body)),
      });
    }
    expect(seen).toHaveLength(7);
    for (const s of seen) {
      expect(s.view, s.cause).toEqual(seen[0]!.view);
      for (const name of FIXTURE_NAMES)
        expect(s.raw, s.cause).not.toContain(name);
      for (const on of [sources.source, sources.archived, sources.missing]) {
        expect(s.raw, s.cause).not.toContain(on.slug);
      }
    }
  });

  it("does not name a third party's saved query on a not_available saved panel", async () => {
    const viewer = newQueryUser();
    users.push(viewer.id);
    const query = await db.savedQueries.create({
      ownerId: sources.owner.id,
      sourceId: sources.source.id,
      name: "Third party query name",
      description: "",
      query: causeQueryOn(sources.source),
      availableForDashboards: false,
    });
    const other = newQueryUser();
    users.push(other.id);
    const panel = await savedPanelRow(other.id, query.id, CHART);
    await shareSavedPanelDirectly(
      panel.id,
      { type: "user", id: viewer.id },
      other.id
    );
    const res = await savedPanelsCall("GET", `/${panel.id}`, viewer.token);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("not_available");
    expect(res.body).not.toHaveProperty("chart");
    expect(res.body).not.toHaveProperty("saved_query_id");
    expect(JSON.stringify(res.body)).not.toContain(query.name);
    await prisma.savedPanel.deleteMany({ where: { id: panel.id } });
  });
});
