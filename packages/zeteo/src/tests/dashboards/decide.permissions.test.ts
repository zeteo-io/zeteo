// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decidePanels } from "../../dashboards/decide.js";
import { removeSources } from "../support/sources.js";
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

// Review Focus #1: a dashboard shared to someone signed in to another
// organization. Its panels on toggle-on saved queries of the owner's
// organization are not_available to them, with no chart settings.

const QUERY = { from: "orders", select: ["id", "status", "total"] };
const CHART = { type: "bar", version: 1, x: "status", y: ["total"] };
const HIDDEN = [
  "chart",
  "time_column",
  "saved_query_id",
  "saved_panel_id",
  "problems",
];

describe("panels across organizations", () => {
  let source: SeededSource;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const owner = newQueryUser();
  const third = newQueryUser();
  const reader = newQueryUser();

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "decideorg");
    for (const u of [owner, third, reader]) {
      await grantTo(u.principal, source.tables.orders!, "all");
    }
  });
  afterAll(async () => {
    await removeDashboardsOf([owner.id, third.id]);
    await removeSources([source.id]);
  });

  const decide = async (
    dash: Awaited<ReturnType<typeof dashboardWith>>,
    org: string | null
  ) => {
    const decisions = await decidePanels(
      viewer(reader.id, org),
      dash,
      "last_7_days"
    );
    return dash.panels.map((p) => panelView(p, decisions.get(p.id)!));
  };

  it("an own panel on organization A's available saved query is not_available from organization B, ok from A", async () => {
    const sq = await savedQueryRow(third.id, source, QUERY, {
      availableForDashboards: true,
      availableOrganizationId: orgA,
    });
    const dash = await dashboardWith(owner.id, [
      {
        kind: "own",
        savedQueryId: sq.id,
        chart: CHART,
        timeColumn: "created_at",
      },
    ]);
    const [fromB] = await decide(dash, orgB);
    expect(fromB!.state).toBe("not_available");
    expect(fromB!.message).toBe(
      "This saved query is no longer available for dashboards."
    );
    for (const key of HIDDEN) expect(fromB).not.toHaveProperty(key);
    const [none] = await decide(dash, null);
    expect(none!.state).toBe("not_available");
    const [fromA] = await decide(dash, orgA);
    expect(fromA!.state).toBe("ok");
    expect(fromA!.chart).toEqual(CHART);
  });

  it("a linked panel on organization A's available saved query is not_available from organization B", async () => {
    const sq = await savedQueryRow(third.id, source, QUERY, {
      availableForDashboards: true,
      availableOrganizationId: orgA,
    });
    const sp = await savedPanelRow(owner.id, sq.id, CHART, "created_at");
    const dash = await dashboardWith(owner.id, [
      { kind: "linked", savedPanelId: sp.id },
    ]);
    const [fromB] = await decide(dash, orgB);
    expect(fromB!.state).toBe("not_available");
    for (const key of HIDDEN) expect(fromB).not.toHaveProperty(key);
    expect((await decide(dash, orgA))[0]!.state).toBe("ok");
  });

  it("a saved query available with no organization reaches only viewers signed in without one", async () => {
    const sq = await savedQueryRow(third.id, source, QUERY, {
      availableForDashboards: true,
      availableOrganizationId: null,
    });
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    expect((await decide(dash, null))[0]!.state).toBe("ok");
    expect((await decide(dash, orgA))[0]!.state).toBe("not_available");
  });

  it("the owner's own saved query reaches viewers of any organization", async () => {
    const sq = await savedQueryRow(owner.id, source, QUERY);
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: sq.id, chart: CHART },
    ]);
    expect((await decide(dash, orgB))[0]!.state).toBe("ok");
  });
});
