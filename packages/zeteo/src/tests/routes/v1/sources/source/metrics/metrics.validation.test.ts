// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
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

describe("POST and PATCH /v1/sources/:sourceId/metrics: checks of a definition", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();

  const create = (formula: unknown) =>
    api(
      "POST",
      `/${source.id}/metrics`,
      editor.token,
      metricBody("draft", formula)
    );

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    await grantTo(editor.principal, source.tables.orders!, "all");
    await setEditors(app.url, source.id, [editor.principal]);
    await createMeasures(app.url, source.id, editor.token, [
      measureBody("revenue", { sum: "total" }),
      measureBody("last_status", { max: "status" }),
    ]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it.each([
    [
      "a column",
      { add: ["total", { measure: "revenue" }] },
      ["formula", "add", 0],
    ],
    [
      "a case",
      { case: { when: [{ if: { status: { eq: "paid" } }, then: 1 }] } },
      ["formula", "case"],
    ],
    ["no measure", { add: [1, 2] }, ["formula"]],
    ["an aggregate", { sum: "total" }, ["formula", "sum"]],
  ])("refuses a formula with %s, at its path", async (_, formula, path) => {
    const res = await create(formula);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_operator", path });
  });

  it("refuses a measure that is not a number", async () => {
    const res = await create({ measure: "last_status" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "invalid_operator",
      path: ["formula"],
    });
  });

  it("refuses a measure that does not exist as not found", async () => {
    const res = await create({
      add: [{ measure: "revenue" }, { measure: "nope" }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["formula"],
    });
  });

  it("accepts calendar constants and a fixed measure in a formula", async () => {
    await createMeasures(app.url, source.id, editor.token, [
      { ...measureBody("all_time", { sum: "total" }), fixed: true },
    ]);
    const res = await create({
      div: [
        {
          mul: [
            { measure: "revenue" },
            { businessDaysInMonth: { date: "2026-06-01" } },
          ],
        },
        { measure: "all_time" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
