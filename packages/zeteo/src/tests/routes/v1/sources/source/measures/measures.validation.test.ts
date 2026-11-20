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
  setEditors,
  sourcesApi,
  STANDARD_MEASURES,
} from "../../../../../support/measures.js";
import {
  grantTo,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST and PATCH /v1/sources/:sourceId/measures: checks of a definition", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  /** A source allowing one join. */
  let narrow: SeededSource;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  /** An editor granted every column of orders but status. */
  const limited = measureUser();
  /** An editor granted orders' id and total only: no date column. */
  const dateless = measureUser();
  let ids: Record<string, string>;

  const create = (body: unknown, on: SeededSource = source) =>
    api("POST", `/${on.id}/measures`, editor.token, body);

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    narrow = await seedQuerySource(ENGINES[0]!, { max_joins: 1 }, "measures");
    for (const on of [source, narrow]) {
      for (const table of [
        "orders",
        "customers",
        "accounts",
        "order_lines",
        "typed_values",
      ]) {
        await grantTo(editor.principal, on.tables[table]!, "all");
      }
      await setEditors(app.url, on.id, [
        editor.principal,
        limited.principal,
        dateless.principal,
      ]);
    }
    await grantTo(limited.principal, source.tables.orders!, [
      "id",
      "total",
      "created_at",
      "customer_id",
    ]);
    await grantTo(dateless.principal, source.tables.orders!, ["id", "total"]);
    ids = await createMeasures(
      app.url,
      source.id,
      editor.token,
      STANDARD_MEASURES
    );
  });
  afterAll(async () => {
    await removeSources([source.id, narrow.id]);
    await app.close();
  });

  it("refuses a table the editor cannot see as not found, at table", async () => {
    const res = await create({
      ...measureBody("on_nothing", { count: "*" }),
      table: "no_such_table",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["table"],
    });
  });

  it("refuses a column the editor is not granted as not found, at formula", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      limited.token,
      measureBody("statuses", { countDistinct: "status" })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["formula"],
    });
    // Exactly as a column that does not exist.
    const missing = await api(
      "POST",
      `/${source.id}/measures`,
      limited.token,
      measureBody("statuses", { countDistinct: "no_such_column" })
    );
    expect(missing.body.error).toBe(res.body.error);
    expect(missing.body.path).toEqual(res.body.path);
  });

  it("refuses a filter on a column the editor is not granted, at where", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      limited.token,
      measureBody("paid_sum", { sum: "total" }, { status: { eq: "paid" } })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["where"],
    });
  });

  it("refuses a formula that is not group-level", async () => {
    const res = await create(measureBody("bare_total", "total"));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "measure_not_aggregate",
      path: ["formula"],
    });
  });

  it("refuses a measure that would use itself", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.total_revenue}`,
      editor.token,
      { formula: { measure: "paid_ytd" } }
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "measure_cycle",
      path: ["formula"],
    });
  });

  it("refuses a measure reading a to-many relation", async () => {
    const res = await create(
      measureBody("line_qty", { sum: "order_lines.qty" })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "measure_reads_to_many",
      path: ["formula"],
    });
  });

  it("refuses a measure that can never fit the source's joins", async () => {
    const res = await create(
      measureBody("plans", { countDistinct: "customers.accounts.plan" }),
      narrow
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "too_many_joins",
      path: ["formula"],
    });
  });

  it("refuses a filter that would wrap a count of a json column", async () => {
    const res = await create({
      ...measureBody("docs", { count: "doc" }, { id: { gt: 0 } }),
      table: "typed_values",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "invalid_operator",
      path: ["where"],
    });
  });

  it("refuses a change that would break the measures using it", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.total_revenue}`,
      editor.token,
      { table: "customers", formula: { count: "*" } }
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "measure_in_use",
      dependents: [
        { kind: "measure", name: "paid_revenue" },
        { kind: "measure", name: "paid_ytd" },
      ],
    });
  });

  it("refuses a rename or delete while other measures use it", async () => {
    const path = `/${source.id}/measures/${ids.total_revenue}`;
    const renamed = await api("PATCH", path, editor.token, {
      name: "all_revenue",
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body).toMatchObject({
      error: "measure_in_use",
      dependents: [
        { kind: "measure", name: "paid_revenue" },
        { kind: "measure", name: "paid_ytd" },
      ],
    });
    const deleted = await api("DELETE", path, editor.token);
    expect(deleted.status).toBe(409);
    expect(deleted.body.dependents).toEqual([
      { kind: "measure", name: "paid_revenue" },
      { kind: "measure", name: "paid_ytd" },
    ]);
  });

  it("allows a change its dependents still plan with", async () => {
    const res = await api(
      "PATCH",
      `/${source.id}/measures/${ids.total_revenue}`,
      editor.token,
      { formula: { sum: { mul: ["total", 1] } } }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("stores a fixed measure and a date column through a to-one relation", async () => {
    const res = await create({
      ...measureBody("line_qty_by_order_day", { sum: "qty" }),
      table: "order_lines",
      date_column: "orders.created_at",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      fixed: false,
      date_column: "orders.created_at",
    });
    const fixed = await create({
      ...measureBody("last_order_at", { max: "created_at" }),
      fixed: true,
      date_column: "created_at",
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(201);
    expect(fixed.body).toMatchObject({
      fixed: true,
      date_column: "created_at",
    });
    const cleared = await api(
      "PATCH",
      `/${source.id}/measures/${fixed.body.id}`,
      editor.token,
      { fixed: false, date_column: null }
    );
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toMatchObject({ fixed: false, date_column: null });
  });

  it.each([
    ["a column that is not a date", "status", "invalid_operator"],
    ["a to-many relation", "order_lines.qty", "measure_reads_to_many"],
    [
      "a column that does not exist",
      "no_such_column",
      "not_found_or_not_accessible",
    ],
  ])("refuses a date column on %s, at date_column", async (_, column, code) => {
    const res = await create({
      ...measureBody("dated_total", { sum: "total" }),
      date_column: column,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: code, path: ["date_column"] });
  });

  it("refuses a date column the editor is not granted exactly as one that does not exist", async () => {
    const as = (column: string) =>
      api("POST", `/${source.id}/measures`, dateless.token, {
        ...measureBody("dated_total", { sum: "total" }),
        date_column: column,
      });
    const hidden = await as("created_at");
    const missing = await as("no_such_col");
    expect(hidden.status).toBe(400);
    const { request_id: _a, ...h } = hidden.body;
    const { request_id: _b, ...m } = missing.body;
    expect(JSON.stringify(h).replaceAll("created_at", "<column>")).toBe(
      JSON.stringify(m).replaceAll("no_such_col", "<column>")
    );
  });
});
