// @module-tag int
// @module-tag platform
import { removeSources } from "../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { ENGINES } from "../../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  createMeasures,
  createMetrics,
  measureBody,
  measuresAdminToken,
  measureUser,
  metricBody,
  setEditors,
  sourcesApi,
} from "../../../../../../support/measures.js";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../../../../../../support/queries.js";

describe("/v1/sources/:sourceId/metrics/:metricId", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  const reader = newQueryUser();
  let ids: Record<string, string>;

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    for (const who of [editor.principal, reader.principal]) {
      await grantTo(who, source.tables.orders!, "all");
    }
    await setEditors(app.url, source.id, [editor.principal]);
    await createMeasures(app.url, source.id, editor.token, [
      measureBody("revenue", { sum: "total" }),
      measureBody("order_count", { count: "*" }),
    ]);
    ids = await createMetrics(app.url, source.id, editor.token, [
      metricBody("aov", {
        div: [{ measure: "revenue" }, { measure: "order_count" }],
      }),
      metricBody("taken", { measure: "revenue" }),
    ]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it("answers a metric in full to a reader who may use it", async () => {
    const res = await api(
      "GET",
      `/${source.id}/metrics/${ids.aov}`,
      reader.token
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "aov", usable: true });
    expect(res.body).not.toHaveProperty("used_by");
  });

  it("answers an admin with broken", async () => {
    const res = await api(
      "GET",
      `/${source.id}/metrics/${ids.aov}`,
      measuresAdminToken()
    );
    expect(res.body).toMatchObject({
      broken: null,
      used_by: expect.any(Object),
    });
  });

  it("renames a metric and changes its formula", async () => {
    const path = `/${source.id}/metrics/${ids.aov}`;
    const res = await api("PATCH", path, editor.token, {
      name: "average_order",
      formula: {
        round: [
          { div: [{ measure: "revenue" }, { measure: "order_count" }] },
          2,
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name: "average_order" });
    const row = await prisma.metric.findUniqueOrThrow({
      where: { id: ids.aov },
    });
    expect(row.name).toBe("average_order");
    expect(row.updatedBy).toBe(editor.id);
  });

  it("refuses a rename to a name another metric or a measure has", async () => {
    for (const name of ["taken", "revenue"]) {
      const res = await api(
        "PATCH",
        `/${source.id}/metrics/${ids.aov}`,
        editor.token,
        { name }
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("measure_name_taken");
    }
  });

  it("deletes a metric", async () => {
    const path = `/${source.id}/metrics/${ids.taken}`;
    expect((await api("DELETE", path, editor.token)).status).toBe(204);
    expect(
      await prisma.metric.findUnique({ where: { id: ids.taken } })
    ).toBeNull();
    expect((await api("GET", path, reader.token)).status).toBe(404);
  });

  it("answers 404 for a metric that does not exist", async () => {
    const res = await api(
      "GET",
      `/${source.id}/metrics/${randomUUID()}`,
      measuresAdminToken()
    );
    expect(res.status).toBe(404);
  });
});
