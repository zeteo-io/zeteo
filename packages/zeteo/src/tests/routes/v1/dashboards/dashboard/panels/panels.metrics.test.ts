// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { clearDashboardKeys } from "../../../../../support/dashboardRuns.js";
import { ndjsonLines, postExport } from "../../../../../support/exports.js";
import { savedPanelsCall } from "../../../../../support/savedPanels.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import { BASE_URL } from "../../../../../support/http.js";
import {
  savedQueryOf,
  uniqueName,
} from "../../../../../support/savedQueries.js";
import {
  addPanel,
  chartedQuery,
  dashboardOf,
  ownPanel,
} from "../../../../../support/dashboards.js";
import {
  measureBody,
  metricBody,
  seedMeasures,
} from "../../../../../support/measures.js";
import {
  removeUploadSourcesOf,
  seedUploadSource,
} from "../../../../../support/uploads.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

// A panel over a metric query follows the dashboard's time range through
// time_column "range", and through no other; for a table query "range" is an
// ordinary column path.

const LINE = { type: "line", version: 1, x: "period", y: ["roas", "revenue"] };
const TABLE = { type: "table", version: 1 };

describe("panels over metric queries", () => {
  let source: SeededSource;
  const owner = newQueryUser();
  let metricQuery: string;
  let tableQuery: string;

  const post = (body: unknown) =>
    savedPanelsCall("POST", "", owner.token, {
      name: uniqueName("panel"),
      description: "",
      ...(body as object),
    });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashmetrics");
    await grantTo(owner.principal, source.tables.orders!, "all");
    await grantTo(owner.principal, source.tables.ad_spend!, "all");
    await seedMeasures(
      BASE_URL,
      source,
      [
        {
          ...measureBody("revenue", { sum: "total" }),
          date_column: "created_at",
        },
        {
          ...measureBody("spend", { sum: "cost" }),
          table: "ad_spend",
          date_column: "day",
        },
      ],
      [
        metricBody("roas", {
          div: [{ measure: "revenue" }, { measure: "spend" }],
        }),
      ]
    );
    metricQuery = await savedQueryOf(owner.token, source, {
      query: {
        source: source.slug,
        metrics: ["roas", "revenue"],
        bucket: "month",
        orderBy: [{ period: "asc" }],
      },
    });
    tableQuery = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
  });
  afterAll(async () => {
    await clearDashboardKeys();
    await removeDashboardsOf([owner.id]);
    await removeRunsOf([owner.id]);
    await removeSources([source.id]);
    await removeUploadSourcesOf([owner.id]);
  });

  it("accepts time_column range on a panel of a metric query", async () => {
    const id = await dashboardOf(owner.token, { time_range: "last_year" });
    const res = await addPanel(
      owner.token,
      id,
      ownPanel(metricQuery, { chart: LINE, time_column: "range" })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ state: "ok", time_column: "range" });
  });

  it("refuses any other time column on a metric query, and tells the owner which setting", async () => {
    const id = await dashboardOf(owner.token, { time_range: "last_year" });
    for (const time_column of ["created_at", "period"]) {
      const res = await addPanel(
        owner.token,
        id,
        ownPanel(metricQuery, { chart: LINE, time_column })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_panel");
      expect(res.body.problems).toEqual([
        { setting: "time_column", problem: "wrong_type" },
      ]);
    }
  });

  it("reads time_column range on a table query as a column, missing when the table has none", async () => {
    const id = await dashboardOf(owner.token, { time_range: "last_year" });
    const res = await addPanel(
      owner.token,
      id,
      ownPanel(tableQuery, { time_column: "range" })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
    expect(res.body.problems).toEqual([
      { setting: "time_column", problem: "missing_column" },
    ]);
  });

  it("filters a table query on its own column named range", async () => {
    const day = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const upload = await seedUploadSource({
      ownerId: owner.id,
      tables: [
        {
          name: "bookings",
          columns: [
            { name: "id", type: "number" },
            { name: "range", type: "date" },
          ],
          rows: [
            ["1", day(3)],
            ["2", "2001-01-01"],
          ],
        },
      ],
    });
    const rangeQuery = await savedQueryOf(owner.token, upload, {
      query: { source: upload.slug, from: "bookings", select: ["id", "range"] },
    });
    const id = await dashboardOf(owner.token, { time_range: "last_30_days" });
    const panel = await addPanel(
      owner.token,
      id,
      ownPanel(rangeQuery, { chart: TABLE, time_column: "range" })
    );
    expect(panel.status, JSON.stringify(panel.body)).toBe(201);
    expect(panel.body).toMatchObject({ state: "ok", time_column: "range" });
    const res = await postExport({
      token: owner.token,
      body: {},
      baseUrl: BASE_URL,
      path: `/v1/dashboards/${id}/run`,
    });
    expect(res.status, res.text).toBe(200);
    const [line] = ndjsonLines(res.text) as Array<{
      state: string;
      result?: { rows: unknown[][] };
    }>;
    expect(line!.state).toBe("ok");
    expect(line!.result!.rows.map((r) => Number(r[0]))).toEqual([1]);
  });

  it("holds the same rules for a saved panel", async () => {
    const ok = await post({
      saved_query_id: metricQuery,
      chart: LINE,
      time_column: "range",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.time_column).toBe("range");
    const other = await post({
      saved_query_id: metricQuery,
      chart: LINE,
      time_column: "created_at",
    });
    expect(other.status).toBe(400);
    expect(other.body.problems).toEqual([
      { setting: "time_column", problem: "wrong_type" },
    ]);
    const table = await post({
      saved_query_id: tableQuery,
      chart: TABLE,
      time_column: "range",
    });
    expect(table.status).toBe(400);
    expect(table.body.problems).toEqual([
      { setting: "time_column", problem: "missing_column" },
    ]);
  });

  it("runs a metric panel cut to the dashboard's range, and the same panel without a time column over all of it", async () => {
    // The fixture's orders and spend are January to July 2026: nothing in the
    // previous month, whenever this runs after them.
    const id = await dashboardOf(owner.token, { time_range: "previous_month" });
    const ranged = await addPanel(
      owner.token,
      id,
      ownPanel(metricQuery, { chart: LINE, time_column: "range" })
    );
    const whole = await addPanel(
      owner.token,
      id,
      ownPanel(metricQuery, { chart: LINE })
    );
    expect(ranged.status, JSON.stringify(ranged.body)).toBe(201);
    expect(whole.status, JSON.stringify(whole.body)).toBe(201);
    const res = await postExport({
      token: owner.token,
      body: {},
      baseUrl: BASE_URL,
      path: `/v1/dashboards/${id}/run`,
    });
    expect(res.status, res.text).toBe(200);
    const lines = ndjsonLines(res.text) as Array<{
      panel_id: string;
      state: string;
      result?: { rows: unknown[][] };
    }>;
    const rows = (panelId: string) =>
      lines.find((l) => l.panel_id === panelId)!.result!.rows;
    expect(rows(whole.body.id)).toHaveLength(7);
    expect(rows(ranged.body.id)).toHaveLength(0);
  });
});
