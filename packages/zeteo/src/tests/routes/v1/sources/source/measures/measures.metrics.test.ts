// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  createMeasures,
  createMetrics,
  measureBody,
  measureUser,
  metricBody,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  grantTo,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

// What a change to a measure does to the metrics using it: refused while it
// would break one (Review Focus 5), and names unique across both kinds.

describe("/v1/sources/:sourceId/measures: measures used by metrics", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  let ids: Record<string, string>;

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    for (const table of ["orders", "ad_spend"]) {
      await grantTo(editor.principal, source.tables[table]!, "all");
    }
    await setEditors(app.url, source.id, [editor.principal]);
    ids = await createMeasures(app.url, source.id, editor.token, [
      {
        ...measureBody("revenue", { sum: "total" }),
        date_column: "created_at",
      },
      {
        ...measureBody("spend", { sum: "cost" }),
        table: "ad_spend",
        date_column: "day",
      },
      measureBody("paid", { measure: "revenue" }, { status: { eq: "paid" } }),
      measureBody("unused", { count: "*" }),
    ]);
    await createMetrics(app.url, source.id, editor.token, [
      metricBody("roas", {
        div: [{ measure: "revenue" }, { measure: "spend" }],
      }),
    ]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it("refuses to delete a measure a metric uses, naming the metric", async () => {
    const res = await api(
      "DELETE",
      `/${source.id}/measures/${ids.spend}`,
      editor.token
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "measure_in_use",
      dependents: [{ kind: "metric", name: "roas" }],
    });
    expect(
      await prisma.measure.findUnique({ where: { id: ids.spend } })
    ).not.toBeNull();
  });

  it("names measures and metrics apart, measures first", async () => {
    const res = await api(
      "DELETE",
      `/${source.id}/measures/${ids.revenue}`,
      editor.token
    );
    expect(res.status).toBe(409);
    expect(res.body.dependents).toEqual([
      { kind: "measure", name: "paid" },
      { kind: "metric", name: "roas" },
    ]);
  });

  it("refuses to rename a measure a metric uses", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.spend}`,
      editor.token,
      { name: "ad_cost" }
    );
    expect(res.status).toBe(409);
    expect(res.body.dependents).toEqual([{ kind: "metric", name: "roas" }]);
  });

  it("refuses to remove a date column a metric's periods need", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.spend}`,
      editor.token,
      { date_column: null }
    );
    expect(res.status).toBe(409);
    expect(res.body.dependents).toEqual([{ kind: "metric", name: "roas" }]);
  });

  it("refuses a formula a metric could no longer combine", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.spend}`,
      editor.token,
      { formula: { max: "channel" } }
    );
    expect(res.status).toBe(409);
    expect(res.body.dependents).toEqual([{ kind: "metric", name: "roas" }]);
  });

  it("allows a change the metric still plans with", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.spend}`,
      editor.token,
      { where: { cost: { gt: 0 } } }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("deletes a measure no metric uses", async () => {
    const res = await api(
      "DELETE",
      `/${source.id}/measures/${ids.unused}`,
      editor.token
    );
    expect(res.status).toBe(204);
  });

  it("refuses a measure named as a metric is, on create and on rename", async () => {
    const created = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("roas", { count: "*" })
    );
    expect(created.status).toBe(409);
    expect(created.body.error).toBe("measure_name_taken");
    const renamed = await api(
      "PATCH",
      `/${source.id}/measures/${ids.paid}`,
      editor.token,
      { name: "roas" }
    );
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toBe("measure_name_taken");
  });
});
