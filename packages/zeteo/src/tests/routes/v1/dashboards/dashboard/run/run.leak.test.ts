// @module-tag int
// @module-tag platform
import { shareDashboardDirectly } from "../../../../../support/dashboards.js";
import { clearDashboardKeys } from "../../../../../support/dashboardRuns.js";
import { ndjsonLines, postExport } from "../../../../../support/exports.js";
import { grantTo, newQueryUser } from "../../../../../support/queries.js";
import { BASE_URL, fetchJson } from "../../../../../support/http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../../../../../utils/db/index.js";
import {
  causeQueryOn,
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
} from "../../../../../support/savedQueryCauses.js";
import {
  dashboardWith,
  removeDashboardsOf,
} from "../../../../../support/panelDecisions.js";

// A viewer who cannot run a panel learns nothing of why: the seven causes
// give the same line, and each refusal is recorded with its query withheld.

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

describe("POST /v1/dashboards/:dashboardId/run: causes of no access look the same", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];

  beforeAll(async () => {
    await clearDashboardKeys();
    sources = await seedCauseSources({}, "dashrunleak");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeDashboardsOf([sources.owner.id]);
    await removeNoAccessCases(sources, users);
    await clearDashboardKeys();
  });

  it("streams the same not_accessible line for each of the seven causes, and records each refusal withheld", async () => {
    const cases = (await setUpNoAccessCases(sources, sources.owner)).map(
      (c) => ({
        cause: c.cause,
        savedQueryId: c.id,
        viewerId: c.recipient.id,
        token: c.recipient.token,
      })
    );
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

    const seen: Array<{ cause: string; line: unknown; text: string }> = [];
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
      const res = await postExport({
        token,
        body: { time_range: "last_30_days" },
        path: `/v1/dashboards/${dash.id}/run`,
      });
      expect(res.status, cause).toBe(200);
      const lines = ndjsonLines(res.text) as Array<Record<string, unknown>>;
      expect(lines, cause).toHaveLength(2);
      expect(lines[1]).toEqual({ done: true });
      const { panel_id: panelId, ...line } = lines[0]!;
      expect(panelId, cause).toBe(dash.panels[0]!.id);
      expect(line, cause).toEqual({
        state: "not_accessible",
        message:
          "You need expanded permissions to run this saved query. Ask an admin to extend your access.",
      });
      seen.push({ cause, line, text: res.text });

      const runs = await fetchJson("GET", `${BASE_URL}/v1/me/runs`, token);
      expect(runs.status, cause).toBe(200);
      expect(runs.body.data, cause).toHaveLength(1);
      expect(runs.body.data[0], cause).toMatchObject({
        source_id: null,
        entry_point: "dashboard",
        query: { withheld: true },
        outcome: "refused",
        error_code: "saved_query_not_accessible",
      });
    }
    expect(seen).toHaveLength(7);
    for (const s of seen) {
      expect(s.line, s.cause).toEqual(seen[0]!.line);
      for (const name of FIXTURE_NAMES)
        expect(s.text, s.cause).not.toContain(name);
      for (const on of [sources.source, sources.archived, sources.missing]) {
        expect(s.text, s.cause).not.toContain(on.slug);
      }
    }
  });
});
