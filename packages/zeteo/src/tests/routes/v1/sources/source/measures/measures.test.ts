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
  measureBody,
  measuresAdminToken,
  measureUser,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("/v1/sources/:sourceId/measures", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const editor = measureUser();
  const reader = newQueryUser();
  const api = sourcesApi(() => app.url);

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    for (const who of [editor.principal, reader.principal]) {
      for (const table of ["orders", "customers"]) {
        await grantTo(who, source.tables[table]!, "all");
      }
    }
    await setEditors(app.url, source.id, [editor.principal]);
  });
  afterAll(async () => {
    await removeRunsOf([editor.id, reader.id]);
    await removeSources([source.id]);
    await app.close();
  });

  it("creates a measure and answers its view", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("order_count", { count: "*" })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: "order_count",
      description: "The order count",
      table: "orders",
      formula: { count: "*" },
      where: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      usable: true,
      used_by: { saved_queries: 0, panels: 0 },
    });
    const row = await prisma.measure.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.tableId).toBe(source.tables.orders!.id);
    expect(row.createdBy).toBe(editor.id);
  });

  it("lists the measures a reader may use in full, without used_by", async () => {
    await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("paid_total", { sum: "total" }, { status: { eq: "paid" } })
    );
    const res = await api("GET", `/${source.id}/measures`, reader.token);
    expect(res.status).toBe(200);
    const paid = res.body.data.find(
      (m: { name: string }) => m.name === "paid_total"
    );
    expect(paid).toMatchObject({
      table: "orders",
      formula: { sum: "total" },
      where: { status: { eq: "paid" } },
      usable: true,
    });
    expect(paid).not.toHaveProperty("used_by");
    expect(paid).not.toHaveProperty("broken");
  });

  it("lists every measure to an admin with used_by and broken", async () => {
    const res = await api(
      "GET",
      `/${source.id}/measures`,
      measuresAdminToken()
    );
    expect(res.status).toBe(200);
    const names = res.body.data.map((m: { name: string }) => m.name);
    expect(names).toEqual([...names].sort());
    for (const item of res.body.data) {
      expect(item).toMatchObject({
        used_by: { saved_queries: 0, panels: 0 },
        broken: null,
      });
    }
  });

  it("changes a measure's description, then deletes it", async () => {
    const created = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("max_total", { max: "total" })
    );
    const path = `/${source.id}/measures/${created.body.id}`;
    const patched = await api("PATCH", path, editor.token, {
      description: "The largest order",
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.description).toBe("The largest order");
    expect(patched.body.formula).toEqual({ max: "total" });

    const got = await api("GET", path, reader.token);
    expect(got.status).toBe(200);
    expect(got.body.description).toBe("The largest order");

    const deleted = await api("DELETE", path, editor.token);
    expect(deleted.status).toBe(204);
    expect(
      await prisma.measure.findUnique({ where: { id: created.body.id } })
    ).toBeNull();
    expect((await api("GET", path, reader.token)).status).toBe(404);
  });

  it("lets a query use a new measure at once", async () => {
    await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("revenue_sum", { sum: "total" })
    );
    const withMeasure = await postQuery(
      reader.token,
      {
        source: source.slug,
        from: "orders",
        select: [{ measure: "revenue_sum" }],
      },
      app.url
    );
    const plain = await postQuery(
      reader.token,
      { source: source.slug, from: "orders", select: [{ sum: "total" }] },
      app.url
    );
    expect(withMeasure.status, JSON.stringify(withMeasure.body)).toBe(200);
    expect(withMeasure.body.columns[0].name).toBe("revenue_sum");
    expect(Number(withMeasure.body.rows[0][0])).toBe(
      Number(plain.body.rows[0][0])
    );
  });

  it("counts the saved queries using a measure and the panels showing them", async () => {
    const created = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("used_measure", { avg: "total" })
    );
    const saved = await prisma.savedQuery.create({
      data: {
        ownerId: editor.id,
        sourceId: source.id,
        name: `uses ${randomUUID().slice(0, 8)}`,
        query: {
          source: source.slug,
          from: "orders",
          select: [
            "status",
            { calc: { mul: [{ measure: "used_measure" }, 2] }, as: "x" },
          ],
          groupBy: ["status"],
        },
      },
    });
    const dashboard = await prisma.dashboard.create({
      data: { ownerId: editor.id, name: `d ${randomUUID().slice(0, 8)}` },
    });
    try {
      await prisma.dashboardPanel.create({
        data: {
          dashboardId: dashboard.id,
          kind: "own",
          x: 0,
          y: 0,
          w: 6,
          h: 4,
          savedQueryId: saved.id,
        },
      });
      const res = await api(
        "GET",
        `/${source.id}/measures/${created.body.id}`,
        editor.token
      );
      expect(res.body.used_by).toEqual({ saved_queries: 1, panels: 1 });
      // A saved query naming another measure does not count.
      const other = await api("GET", `/${source.id}/measures`, editor.token);
      const revenue = other.body.data.find(
        (m: { name: string }) => m.name === "revenue_sum"
      );
      expect(revenue.used_by).toEqual({ saved_queries: 0, panels: 0 });
    } finally {
      await prisma.dashboard.delete({ where: { id: dashboard.id } });
    }
  });

  it("refuses a duplicate name with 409", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      editor.token,
      measureBody("order_count", { count: "id" })
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("measure_name_taken");
  });

  it("answers 400 with the service's error shape for a bad body", async () => {
    const res = await api("POST", `/${source.id}/measures`, editor.token, {
      ...measureBody("Bad Name", { count: "*" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/name/);
  });

  it("answers 404 for a source that does not exist", async () => {
    const res = await api(
      "GET",
      `/${randomUUID()}/measures`,
      measuresAdminToken()
    );
    expect(res.status).toBe(404);
  });
});
