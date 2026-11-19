// @module-tag int
// @module-tag platform
// @module-tag security
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
  setEditors,
  sourcesApi,
  STANDARD_MEASURES,
  withoutRequestId,
} from "../../../../../support/measures.js";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

const GRANTED_ORDERS = ["id", "total", "created_at", "customer_id"];

describe("/v1/sources/:sourceId/measures: a measure over a column the caller lacks", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const author = measureUser();
  /** An editor without orders.status. */
  const editor = measureUser();
  /** A reader without orders.status. */
  const reader = newQueryUser();
  let ids: Record<string, string>;

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    await grantTo(author.principal, source.tables.orders!, "all");
    await grantTo(editor.principal, source.tables.orders!, GRANTED_ORDERS);
    await grantTo(reader.principal, source.tables.orders!, GRANTED_ORDERS);
    await setEditors(app.url, source.id, [author.principal, editor.principal]);
    ids = await createMeasures(
      app.url,
      source.id,
      author.token,
      STANDARD_MEASURES
    );
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it("lists it to an editor redacted: no formula and no where", async () => {
    const res = await api("GET", `/${source.id}/measures`, editor.token);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.data.map((m: { name: string }) => [m.name, m])
    );
    for (const name of ["paid_revenue", "paid_ytd"]) {
      expect(byName[name]).toEqual({
        name,
        description: expect.any(String),
        table: "orders",
        usable: false,
      });
    }
    expect(byName.total_revenue).toMatchObject({
      formula: { sum: "total" },
      usable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('"status"');
  });

  it("leaves it out of a reader's list", async () => {
    const res = await api("GET", `/${source.id}/measures`, reader.token);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual([
      "total_revenue",
    ]);
  });

  it.each([
    ["GET", undefined],
    ["PATCH", { description: "Changed" }],
    ["DELETE", undefined],
  ])(
    "answers %s exactly as for a measure that does not exist",
    async (method, body) => {
      const hidden = await api(
        method,
        `/${source.id}/measures/${ids.paid_revenue}`,
        editor.token,
        body
      );
      const random = await api(
        method,
        `/${source.id}/measures/${randomUUID()}`,
        editor.token,
        body
      );
      expect(hidden.status).toBe(404);
      expect(withoutRequestId(hidden)).toEqual(withoutRequestId(random));
    }
  );

  it("leaves it unchanged after the refusals", async () => {
    const row = await prisma.measure.findUniqueOrThrow({
      where: { id: ids.paid_revenue },
    });
    expect(row.description).toBe(STANDARD_MEASURES[1]!.description);
  });

  it("answers a reader's GET exactly as for a measure that does not exist", async () => {
    const hidden = await api(
      "GET",
      `/${source.id}/measures/${ids.paid_ytd}`,
      reader.token
    );
    const random = await api(
      "GET",
      `/${source.id}/measures/${randomUUID()}`,
      reader.token
    );
    expect(hidden.status).toBe(404);
    expect(withoutRequestId(hidden)).toEqual(withoutRequestId(random));
  });
});

describe("/v1/sources/:sourceId/measures: a date column the caller lacks", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const author = measureUser();
  /** An editor granted orders' id and total: not created_at. */
  const editor = measureUser();
  /** A reader granted orders' id and total. */
  const reader = newQueryUser();
  let ids: Record<string, string>;

  /** A measure's view without what tells two measures apart anyway. */
  const shape = (body: Record<string, unknown>) => {
    const {
      id: _i,
      name: _n,
      description: _d,
      created_at: _c,
      updated_at: _u,
      ...rest
    } = body;
    return rest;
  };

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    await grantTo(author.principal, source.tables.orders!, "all");
    for (const who of [editor.principal, reader.principal]) {
      await grantTo(who, source.tables.orders!, ["id", "total"]);
    }
    await setEditors(app.url, source.id, [author.principal, editor.principal]);
    ids = await createMeasures(app.url, source.id, author.token, [
      { ...measureBody("dated", { sum: "total" }), date_column: "created_at" },
      measureBody("undated", { sum: "total" }),
    ]);
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await app.close();
  });

  it.each([
    ["a reader", () => reader.token],
    ["an editor", () => editor.token],
  ])(
    "shows %s the measure exactly as one with no date column",
    async (_, token) => {
      const get = (id: string) =>
        api("GET", `/${source.id}/measures/${id}`, token());
      const dated = await get(ids.dated!);
      const undated = await get(ids.undated!);
      expect(dated.status).toBe(200);
      expect(dated.body.date_column).toBeNull();
      expect(shape(dated.body)).toEqual(shape(undated.body));
      const list = await api("GET", `/${source.id}/measures`, token());
      const listed = list.body.data.find(
        (m: { name: string }) => m.name === "dated"
      );
      expect(listed.date_column).toBeNull();
      expect(JSON.stringify(list.body)).not.toContain(
        '"date_column":"created_at"'
      );
    }
  );

  it("shows it to whoever sees every measure", async () => {
    const res = await api(
      "GET",
      `/${source.id}/measures/${ids.dated}`,
      measuresAdminToken()
    );
    expect(res.body.date_column).toBe("created_at");
  });

  it("lets the editor change the measure, keeping the date column they cannot see", async () => {
    const path = `/${source.id}/measures/${ids.dated}`;
    const res = await api("PATCH", path, editor.token, {
      description: "Changed by an editor without the date column",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.date_column).toBeNull();
    const row = await prisma.measure.findUniqueOrThrow({
      where: { id: ids.dated },
    });
    expect(row.dateColumn).toBe("created_at");

    const set = await api("PATCH", path, editor.token, {
      date_column: "created_at",
    });
    expect(set.status).toBe(400);
    expect(set.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["date_column"],
    });
  });
});
