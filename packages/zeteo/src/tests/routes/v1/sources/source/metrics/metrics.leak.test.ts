// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonResponse } from "../../../../../support/http.js";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  createMeasures,
  createMetrics,
  measureBody,
  measureUser,
  metricBody,
  setEditors,
  sourcesApi,
  withoutRequestId,
} from "../../../../../support/measures.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

// Review Focus 3: a metric using a measure the caller cannot see is, to
// them, a metric that does not exist; an editor sees it listed redacted.

const GRANTED_ORDERS = ["id", "total", "created_at", "customer_id"];

/** A refusal with `name` written as `<name>`, so two refusals of different names compare whole. */
const named = (res: JsonResponse, name: string) =>
  JSON.parse(JSON.stringify(withoutRequestId(res)).replaceAll(name, "<name>"));

describe("/v1/sources/:sourceId/metrics: a metric over a measure the caller lacks", () => {
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
    source = await seedQuerySource(ENGINES[0]!, {}, "metrics");
    await grantTo(author.principal, source.tables.orders!, "all");
    for (const who of [editor.principal, reader.principal]) {
      await grantTo(who, source.tables.orders!, GRANTED_ORDERS);
    }
    for (const who of [author.principal, editor.principal, reader.principal]) {
      await grantTo(who, source.tables.ad_spend!, "all");
    }
    await setEditors(app.url, source.id, [author.principal, editor.principal]);
    await createMeasures(app.url, source.id, author.token, [
      {
        ...measureBody("revenue", { sum: "total" }),
        date_column: "created_at",
      },
      {
        ...measureBody(
          "paid_revenue",
          { sum: "total" },
          { status: { eq: "paid" } }
        ),
        date_column: "created_at",
      },
      {
        ...measureBody("spend", { sum: "cost" }),
        table: "ad_spend",
        date_column: "day",
      },
    ]);
    ids = await createMetrics(app.url, source.id, author.token, [
      metricBody("roas", {
        div: [{ measure: "revenue" }, { measure: "spend" }],
      }),
      metricBody("paid_roas", {
        div: [{ measure: "paid_revenue" }, { measure: "spend" }],
      }),
    ]);
  });
  afterAll(async () => {
    await removeRunsOf([reader.id, editor.id]);
    await removeSources([source.id]);
    await app.close();
  });

  it("lists it to an editor redacted: no formula", async () => {
    const res = await api("GET", `/${source.id}/metrics`, editor.token);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.data.map((m: { name: string }) => [m.name, m])
    );
    expect(byName.paid_roas).toEqual({
      name: "paid_roas",
      description: "The paid roas",
      usable: false,
    });
    expect(byName.roas).toMatchObject({
      usable: true,
      formula: expect.any(Object),
    });
    expect(JSON.stringify(res.body)).not.toContain("paid_revenue");
  });

  it("leaves it out of a reader's list", async () => {
    const res = await api("GET", `/${source.id}/metrics`, reader.token);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual([
      "roas",
    ]);
  });

  it.each([
    ["GET", undefined],
    ["PATCH", { description: "Changed" }],
    ["DELETE", undefined],
  ])(
    "answers an editor's %s exactly as for a metric that does not exist",
    async (method, body) => {
      const hidden = await api(
        method,
        `/${source.id}/metrics/${ids.paid_roas}`,
        editor.token,
        body
      );
      const random = await api(
        method,
        `/${source.id}/metrics/${randomUUID()}`,
        editor.token,
        body
      );
      expect(hidden.status).toBe(404);
      expect(withoutRequestId(hidden)).toEqual(withoutRequestId(random));
    }
  );

  it("leaves it unchanged after the refusals", async () => {
    const row = await prisma.metric.findUniqueOrThrow({
      where: { id: ids.paid_roas },
    });
    expect(row.description).toBe("The paid roas");
  });

  it("answers a reader's GET exactly as for a metric that does not exist", async () => {
    const hidden = await api(
      "GET",
      `/${source.id}/metrics/${ids.paid_roas}`,
      reader.token
    );
    const random = await api(
      "GET",
      `/${source.id}/metrics/${randomUUID()}`,
      reader.token
    );
    expect(hidden.status).toBe(404);
    expect(withoutRequestId(hidden)).toEqual(withoutRequestId(random));
  });

  it("refuses an editor's metric over the measure exactly as over one that does not exist", async () => {
    const create = (measure: string) =>
      api(
        "POST",
        `/${source.id}/metrics`,
        editor.token,
        metricBody("draft", { add: [{ measure }, { measure: "spend" }] })
      );
    const hidden = await create("paid_revenue");
    const missing = await create("no_such_measure");
    expect(hidden.status).toBe(400);
    expect(hidden.body).toMatchObject({
      error: "not_found_or_not_accessible",
      path: ["formula"],
    });
    expect(named(hidden, "paid_revenue")).toEqual(
      named(missing, "no_such_measure")
    );
  });

  it("answers a reader's metric query for it exactly as for a metric that does not exist", async () => {
    const ask = (name: string) =>
      postQuery(
        reader.token,
        { source: source.slug, metrics: [name], bucket: "month" },
        app.url
      );
    const hidden = await ask("paid_roas");
    const missing = await ask("no_such_metric");
    expect(hidden.status).toBe(422);
    expect(hidden.body.error).toBe("not_found_or_not_accessible");
    expect(named(hidden, "paid_roas")).toEqual(
      named(missing, "no_such_metric")
    );
  });
});
