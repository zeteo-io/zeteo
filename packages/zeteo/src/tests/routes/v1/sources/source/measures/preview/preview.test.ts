// @module-tag int
// @module-tag platform
import { removeSources } from "../../../../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { ENGINES } from "../../../../../../support/engines.js";
import {
  createMeasures,
  measureBody,
  measureUser,
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

const PAID = { status: { eq: "paid" } };

describe("POST /v1/sources/:sourceId/measures/preview", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  const stranger = measureUser();
  /** An editor without orders.status. */
  const limited = measureUser();

  const preview = (body: unknown, token = editor.token) =>
    api("POST", `/${source.id}/measures/preview`, token, body);
  const query = (body: object) =>
    postQuery(
      editor.token,
      { source: source.slug, from: "orders", ...body },
      app.url
    );

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    await grantTo(editor.principal, source.tables.orders!, "all");
    await grantTo(stranger.principal, source.tables.orders!, "all");
    await grantTo(limited.principal, source.tables.orders!, ["id", "total"]);
    await setEditors(app.url, source.id, [editor.principal, limited.principal]);
    await createMeasures(app.url, source.id, editor.token, [
      measureBody("total_revenue", { sum: "total" }),
    ]);
  });
  afterAll(async () => {
    await removeRunsOf([editor.id, stranger.id, limited.id]);
    await removeSources([source.id]);
    await app.close();
  });

  it("returns a draft's value, and records the run as a preview", async () => {
    const res = await preview({
      measure: measureBody("draft_paid", { sum: "total" }, PAID),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "draft_paid",
    ]);
    const paid = await query({ select: [{ sum: "total" }], where: PAID });
    expect(Number(res.body.rows[0][0])).toBe(Number(paid.body.rows[0][0]));

    const run = (await runsOf([editor.id])).find(
      (r) => r.id === res.body.run_id
    );
    expect(run?.entryPoint).toBe("measure_preview");
    expect(run?.outcome).toBe("ok");
  });

  it("returns a row per month when bucketed by month", async () => {
    const res = await preview({
      measure: measureBody("draft_paid", { sum: "total" }, PAID),
      bucket: { unit: "month", column: "created_at" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "period",
      "draft_paid",
    ]);
    const expected = await query({
      select: [
        { bucket: "month", column: "created_at", as: "month" },
        { sum: "total", as: "s" },
      ],
      where: PAID,
      groupBy: ["month"],
      orderBy: [{ month: "asc" }],
    });
    expect(res.body.rows.length).toBeGreaterThan(1);
    expect(res.body.rows.map((r: unknown[]) => [r[0], Number(r[1])])).toEqual(
      expected.body.rows.map((r: unknown[]) => [r[0], Number(r[1])])
    );
  });

  it("previews a change of a stored measure in its place", async () => {
    const res = await preview({
      measure: measureBody("total_revenue", { count: "*" }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const count = await query({ select: [{ count: "*" }] });
    expect(Number(res.body.rows[0][0])).toBe(Number(count.body.rows[0][0]));
  });

  it("refuses a draft over a column the editor is not granted, as a save would", async () => {
    const res = await preview(
      { measure: measureBody("draft_paid", { sum: "total" }, PAID) },
      limited.token
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["where"],
    });
  });

  it("refuses a user who is not an editor with 403", async () => {
    const res = await preview(
      { measure: measureBody("draft_paid", { sum: "total" }) },
      stranger.token
    );
    expect(res.status).toBe(403);
  });
});
