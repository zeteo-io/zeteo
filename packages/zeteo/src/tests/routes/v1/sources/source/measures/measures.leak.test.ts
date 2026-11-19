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
