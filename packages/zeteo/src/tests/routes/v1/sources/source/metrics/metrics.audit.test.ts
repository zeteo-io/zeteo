// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../support/v1App.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  createMeasures,
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

describe("/v1/sources/:sourceId/metrics: audit", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    await grantTo(editor.principal, source.tables.orders!, "all");
    await setEditors(app.url, source.id, [editor.principal]);
    await createMeasures(app.url, source.id, editor.token, [
      measureBody("revenue", { sum: "total" }),
    ]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it("records one entry for each create, change and delete", async () => {
    const created = await api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("audited_double", { mul: [{ measure: "revenue" }, 2] })
    );
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const path = `/${source.id}/metrics/${id}`;
    expect(
      (await api("PATCH", path, editor.token, { description: "Audited" }))
        .status
    ).toBe(200);
    expect((await api("DELETE", path, editor.token)).status).toBe(204);

    const entries = await auditRows(id);
    expect(entries.map((e) => e.payload.metadata.event)).toEqual([
      "zeteo.metric.created",
      "zeteo.metric.updated",
      "zeteo.metric.deleted",
    ]);
    expect(entries.map((e) => e.payload.action)).toEqual([
      "CREATE",
      "UPDATE",
      "DELETE",
    ]);
    for (const entry of entries) {
      expect(entry.payload).toMatchObject({
        entityType: "metric",
        userId: editor.id,
        metadata: { source_id: source.id, name: "audited_double" },
      });
    }
    expect(entries[1]!.payload.metadata.changed).toEqual(["description"]);
  });

  it("records nothing for a refused change", async () => {
    const created = await api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("refused_double", { mul: [{ measure: "revenue" }, 2] })
    );
    const id = created.body.id as string;
    const refused = await api(
      "PATCH",
      `/${source.id}/metrics/${id}`,
      editor.token,
      { formula: "total" }
    );
    expect(refused.status).toBe(400);
    expect(await auditRows(id)).toHaveLength(1);
  });
});
