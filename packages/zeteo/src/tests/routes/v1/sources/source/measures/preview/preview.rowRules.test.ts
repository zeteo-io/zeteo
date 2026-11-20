// @module-tag int
// @module-tag platform
import { removeSources } from "../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { ENGINES } from "../../../../../../support/engines.js";
import {
  measureBody,
  measureUser,
  setEditors,
  sourcesApi,
} from "../../../../../../support/measures.js";
import {
  grantTo,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../../support/queries.js";

// A draft previewed by an editor with a row rule is computed over the rows
// the editor's rule keeps, not the table.

describe("measure preview under row rules", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  const admin = measureUser();

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "previewrules");
    await grantTo(editor.principal, source.tables.orders!, "all", {
      access: "rule",
      rule: { status: { eq: "paid" } },
    });
    await grantTo(admin.principal, source.tables.orders!, "all");
    await setEditors(app.url, source.id, [editor.principal, admin.principal]);
  });
  afterAll(async () => {
    await removeRunsOf([editor.id, admin.id]);
    await removeSources([source.id]);
    await app.close();
  });

  it("previews a draft over the editor's rows only", async () => {
    const draft = measureBody("draft_total", { sum: "total" });
    const res = await api(
      "POST",
      `/${source.id}/measures/preview`,
      editor.token,
      { measure: draft }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const paid = await postQuery(
      admin.token,
      {
        source: source.slug,
        from: "orders",
        select: [{ sum: "total" }],
        where: { status: { eq: "paid" } },
      },
      app.url
    );
    const all = await api(
      "POST",
      `/${source.id}/measures/preview`,
      admin.token,
      { measure: draft }
    );
    const value = Number(res.body.rows[0][0]);
    expect(value).toBe(Number(paid.body.rows[0][0]));
    expect(value).toBeLessThan(Number(all.body.rows[0][0]));
  });
});
