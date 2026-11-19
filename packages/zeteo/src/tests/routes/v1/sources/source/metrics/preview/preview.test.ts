// @module-tag int
// @module-tag platform
import { removeSources } from "../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { ENGINES } from "../../../../../../support/engines.js";
import {
  createMeasures,
  createMetrics,
  measureBody,
  measureUser,
  metricBody,
  setEditors,
  sourcesApi,
} from "../../../../../../support/measures.js";
import {
  grantTo,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../../support/queries.js";

const ROAS = { div: [{ measure: "revenue" }, { measure: "spend" }] };

describe("POST /v1/sources/:sourceId/metrics/preview", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  const stranger = measureUser();
  /** An editor without orders.status. */
  const limited = measureUser();

  const preview = (body: unknown, token = editor.token) =>
    api("POST", `/${source.id}/metrics/preview`, token, body);
  const query = (body: object) =>
    postQuery(editor.token, { source: source.slug, ...body }, app.url);

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    for (const who of [editor.principal, stranger.principal]) {
      await grantTo(who, source.tables.orders!, "all");
      await grantTo(who, source.tables.ad_spend!, "all");
    }
    await grantTo(limited.principal, source.tables.orders!, [
      "id",
      "total",
      "created_at",
    ]);
    await grantTo(limited.principal, source.tables.ad_spend!, "all");
    await setEditors(app.url, source.id, [editor.principal, limited.principal]);
    await createMeasures(app.url, source.id, editor.token, [
      {
        ...measureBody("revenue", { sum: "total" }),
        date_column: "created_at",
      },
      {
        ...measureBody(
          "paid_revenue",
          { sum: "total" },
          { status: { eq: "paid" } }
        ),
        date_column: "created_at",
      },
      {
        ...measureBody("spend", { sum: "cost" }),
        table: "ad_spend",
        date_column: "day",
      },
    ]);
    await createMetrics(app.url, source.id, editor.token, [
      metricBody("stored", { add: [{ measure: "revenue" }, 1] }),
    ]);
  });
  afterAll(async () => {
    await removeRunsOf([editor.id, stranger.id, limited.id]);
    await removeSources([source.id]);
    await app.close();
  });

  it("returns a draft's value, and records the run as a preview", async () => {
    const res = await preview({ metric: metricBody("draft_roas", ROAS) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "draft_roas",
    ]);
    const parts = await query({ metrics: ["revenue", "spend"] });
    const [revenue, spend] = parts.body.rows[0].map(Number);
    expect(Number(res.body.rows[0][0])).toBeCloseTo(revenue / spend, 6);

    const run = (await runsOf([editor.id])).find(
      (r) => r.id === res.body.run_id
    );
    expect(run?.entryPoint).toBe("measure_preview");
    expect(run?.outcome).toBe("ok");
  });

  it("returns a row per month within the range when bucketed", async () => {
    const range = { gte: { date: "2026-01-01" }, lt: { date: "2026-04-01" } };
    const res = await preview({
      metric: metricBody("draft_roas", ROAS),
      bucket: "month",
      range,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "period",
      "draft_roas",
    ]);
    const expected = await query({
      metrics: ["revenue", "spend"],
      bucket: "month",
      range,
      orderBy: [{ period: "asc" }],
    });
    expect(res.body.rows).toHaveLength(3);
    expect(
      res.body.rows.map((r: unknown[]) => [r[0], Number(r[1]).toFixed(6)])
    ).toEqual(
      expected.body.rows.map((r: unknown[]) => [
        r[0],
        (Number(r[1]) / Number(r[2])).toFixed(6),
      ])
    );
  });

  it("previews a change of a stored metric in its place", async () => {
    const res = await preview({
      metric: metricBody("stored", { mul: [{ measure: "revenue" }, 0] }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(res.body.rows[0][0])).toBe(0);
  });

  it("refuses a draft over a measure the editor cannot see, as a save would", async () => {
    const res = await preview(
      { metric: metricBody("draft", { measure: "paid_revenue" }) },
      limited.token
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["formula"],
    });
  });

  it("refuses a draft named as a measure is", async () => {
    const res = await preview({ metric: metricBody("spend", ROAS) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("measure_name_taken");
  });

  it("refuses a user who is not an editor with 403", async () => {
    const res = await preview(
      { metric: metricBody("draft_roas", ROAS) },
      stranger.token
    );
    expect(res.status).toBe(403);
  });
});
