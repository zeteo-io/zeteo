// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../support/v1App.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  measureBody,
  measureUser,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  grantTo,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("/v1/sources/:sourceId/measures: audit", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    await grantTo(editor.principal, source.tables.orders!, "all");
    await setEditors(app.url, source.id, [editor.principal]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it("records one entry for each create, change and delete", async () => {
    const created = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("audited_sum", { sum: "total" })
    );
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const path = `/${source.id}/measures/${id}`;
    expect(
      (await api("PATCH", path, editor.token, { description: "Audited" }))
        .status
    ).toBe(200);
    expect((await api("DELETE", path, editor.token)).status).toBe(204);

    const entries = await auditRows(id);
    expect(entries.map((e) => e.payload.metadata.event)).toEqual([
      "zeteo.measure.created",
      "zeteo.measure.updated",
      "zeteo.measure.deleted",
    ]);
    expect(entries.map((e) => e.payload.action)).toEqual([
      "CREATE",
      "UPDATE",
      "DELETE",
    ]);
    for (const entry of entries) {
      expect(entry.payload).toMatchObject({
        entityType: "measure",
        userId: editor.id,
        metadata: { source_id: source.id, name: "audited_sum" },
      });
    }
    expect(entries[1]!.payload.metadata.changed).toEqual(["description"]);
  });

  it("records nothing for a refused change", async () => {
    const created = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("refused_sum", { sum: "total" })
    );
    const id = created.body.id as string;
    const refused = await api(
      "PATCH",
      `/${source.id}/measures/${id}`,
      editor.token,
      { formula: "total" }
    );
    expect(refused.status).toBe(400);
    expect(await auditRows(id)).toHaveLength(1);
  });

  it("records one entry for a change of the editors", async () => {
    const before = (await auditRows(source.id)).filter(
      (e) => e.payload.metadata?.event === "zeteo.measure_editors.updated"
    ).length;
    await setEditors(app.url, source.id, []);
    const after = (await auditRows(source.id)).filter(
      (e) => e.payload.metadata?.event === "zeteo.measure_editors.updated"
    );
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "source",
      metadata: { removed: [{ type: "user", id: editor.id }], added: [] },
    });
  });
});
