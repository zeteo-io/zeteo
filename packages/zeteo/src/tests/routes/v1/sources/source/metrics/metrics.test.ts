// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  createMeasures,
  measureBody,
  measuresAdminToken,
  measureUser,
  metricBody,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

const ROAS = { div: [{ measure: "revenue" }, { measure: "spend" }] };

describe("/v1/sources/:sourceId/metrics", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const editor = measureUser();
  const reader = newQueryUser();
  const api = sourcesApi(() => app.url);

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    for (const who of [editor.principal, reader.principal]) {
      for (const table of ["orders", "ad_spend"]) {
        await grantTo(who, source.tables[table]!, "all");
      }
    }
    await setEditors(app.url, source.id, [editor.principal]);
    await createMeasures(app.url, source.id, editor.token, [
      {
        ...measureBody("revenue", { sum: "total" }),
        date_column: "created_at",
      },
      {
        ...measureBody("spend", { sum: "cost" }),
        table: "ad_spend",
        date_column: "day",
      },
    ]);
  });
  afterAll(async () => {
    await removeRunsOf([editor.id, reader.id]);
    await removeSources([source.id]);
    await app.close();
  });

  it("creates a metric and answers its view", async () => {
    const res = await api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("roas", ROAS)
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: "roas",
      description: "The roas",
      formula: ROAS,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      usable: true,
      used_by: { saved_queries: 0, panels: 0 },
    });
    const row = await prisma.metric.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.sourceId).toBe(source.id);
    expect(row.createdBy).toBe(editor.id);
  });

  it("lists the metrics a reader may use in full, without used_by", async () => {
    const res = await api("GET", `/${source.id}/metrics`, reader.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      can_edit: false,
      can_manage_editors: false,
    });
    const roas = res.body.data.find((m: { name: string }) => m.name === "roas");
    expect(roas).toMatchObject({ formula: ROAS, usable: true });
    expect(roas).not.toHaveProperty("used_by");
    expect(roas).not.toHaveProperty("broken");
  });

  it("lists every metric to an admin with used_by and broken, and to an editor with can_edit", async () => {
    const admin = await api(
      "GET",
      `/${source.id}/metrics`,
      measuresAdminToken()
    );
    expect(admin.status).toBe(200);
    for (const item of admin.body.data) {
      expect(item).toMatchObject({
        used_by: { saved_queries: 0, panels: 0 },
        broken: null,
      });
    }
    const own = await api("GET", `/${source.id}/metrics`, editor.token);
    expect(own.body.can_edit).toBe(true);
  });

  it("lets a metric query use a new metric at once", async () => {
    await api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("double_revenue", { mul: [{ measure: "revenue" }, 2] })
    );
    const res = await postQuery(
      reader.token,
      { source: source.slug, metrics: ["double_revenue", "revenue"] },
      app.url
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [doubled, revenue] = res.body.rows[0];
    expect(Number(doubled)).toBeCloseTo(Number(revenue) * 2, 2);
  });

  it("counts the saved queries asking for a metric", async () => {
    const created = await api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("used_metric", { add: [{ measure: "revenue" }, 1] })
    );
    await prisma.savedQuery.create({
      data: {
        ownerId: editor.id,
        sourceId: source.id,
        name: `uses ${randomUUID().slice(0, 8)}`,
        query: {
          source: source.slug,
          metrics: ["used_metric"],
          bucket: "month",
        },
      },
    });
    const res = await api(
      "GET",
      `/${source.id}/metrics/${created.body.id}`,
      editor.token
    );
    expect(res.body.used_by).toEqual({ saved_queries: 1, panels: 0 });
    // A measure asked for by name in a metric query is used by it too.
    await prisma.savedQuery.create({
      data: {
        ownerId: editor.id,
        sourceId: source.id,
        name: `uses ${randomUUID().slice(0, 8)}`,
        query: { source: source.slug, metrics: ["spend"] },
      },
    });
    const measures = await api("GET", `/${source.id}/measures`, editor.token);
    const usedBy = Object.fromEntries(
      measures.body.data.map((m: { name: string; used_by: unknown }) => [
        m.name,
        m.used_by,
      ])
    );
    expect(usedBy).toEqual({
      revenue: { saved_queries: 0, panels: 0 },
      spend: { saved_queries: 1, panels: 0 },
    });
  });

  it("refuses a name a metric or a measure has with 409", async () => {
    for (const name of ["roas", "spend"]) {
      const res = await api(
        "POST",
        `/${source.id}/metrics`,
        editor.token,
        metricBody(name, { measure: "revenue" })
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("measure_name_taken");
    }
  });

  it("answers 400 with the service's error shape for a bad body", async () => {
    const res = await api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("Bad Name", { measure: "revenue" })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/name/);
  });

  it("answers 404 for a source that does not exist", async () => {
    const res = await api(
      "GET",
      `/${randomUUID()}/metrics`,
      measuresAdminToken()
    );
    expect(res.status).toBe(404);
  });
});
