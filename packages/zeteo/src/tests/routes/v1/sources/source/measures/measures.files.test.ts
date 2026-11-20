// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeRunsOf } from "../../../../../support/queries.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { auditRows } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MEASURES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  createMeasures,
  createMetrics,
  measureBody,
  metricBody,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  removeUploadSourcesOf,
  seedUploadSource,
} from "../../../../../support/uploads.js";

const TABLES = [
  {
    name: "sales",
    columns: [
      { name: "id", type: "number" as const },
      { name: "amount", type: "number" as const },
    ],
    rows: [
      ["1", "10"],
      ["2", "32"],
    ],
  },
  {
    name: "returns",
    columns: [
      { name: "id", type: "number" as const },
      { name: "amount", type: "number" as const },
    ],
    rows: [["1", "4"]],
  },
  {
    name: "rates",
    columns: [
      { name: "id", type: "number" as const },
      { name: "rate", type: "number" as const },
    ],
    rows: [["1", "2"]],
  },
];

describe("/v1/sources/:sourceId/measures: upload sources", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const api = sourcesApi(() => app.url);
  const ownerId = randomUUID();
  const token = tokenFor({
    userId: ownerId,
    permissions: [UPLOADS_WRITE, DATA_READ, MEASURES_WRITE],
  });

  const seed = () => seedUploadSource({ ownerId, tables: TABLES });
  const create = (sourceId: string, name: string, table: string) =>
    api("POST", `/${sourceId}/measures`, token, {
      ...measureBody(name, { sum: "amount" }),
      table,
    });

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeRunsOf([ownerId]);
    await removeUploadSourcesOf([ownerId]);
    await app.close();
  });

  it("deletes a table's measures when the table is removed", async () => {
    const source = await seed();
    expect((await create(source.id, "sold", "sales")).status).toBe(201);
    expect((await create(source.id, "returned", "returns")).status).toBe(201);

    const removed = await api(
      "DELETE",
      `/${source.id}/tables/${source.tables.sales!.id}`,
      token
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    const left = await prisma.measure.findMany({
      where: { sourceId: source.id },
    });
    expect(left.map((m) => m.name)).toEqual(["returned"]);
  });

  /**
   * The reviewer's case: a fixed fx_rate on rates, revenue_eur on sales using
   * it, the metric roas on revenue_eur, and rate_x2 on rates' own measure.
   */
  const seedCrossTable = async () => {
    const source = await seed();
    const measures = await createMeasures(app.url, source.id, token, [
      {
        ...measureBody("fx_rate", { avg: "rate" }),
        table: "rates",
        fixed: true,
      },
      {
        ...measureBody("revenue_eur", {
          mul: [{ sum: "amount" }, { measure: "fx_rate" }],
        }),
        table: "sales",
      },
    ]);
    const metrics = await createMetrics(app.url, source.id, token, [
      metricBody("roas", { div: [{ measure: "revenue_eur" }, 2] }),
      metricBody("rate_x2", { mul: [{ measure: "fx_rate" }, 2] }),
    ]);
    return { source, measures, metrics };
  };
  const namesOf = async (sourceId: string) => ({
    measures: (
      await prisma.measure.findMany({
        where: { sourceId },
        orderBy: { name: "asc" },
      })
    ).map((m) => m.name),
    metrics: (
      await prisma.metric.findMany({
        where: { sourceId },
        orderBy: { name: "asc" },
      })
    ).map((m) => m.name),
  });

  it("refuses to remove a table whose measure another table's measure uses, and changes nothing", async () => {
    const { source } = await seedCrossTable();
    const before = await namesOf(source.id);
    const refused = await api(
      "DELETE",
      `/${source.id}/tables/${source.tables.rates!.id}`,
      token
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe("measure_in_use");
    expect(refused.body.dependents).toEqual([
      { kind: "measure", name: "revenue_eur" },
      { kind: "metric", name: "roas" },
    ]);
    expect(await namesOf(source.id)).toEqual(before);
    const table = await prisma.sourceTable.findUniqueOrThrow({
      where: { id: source.tables.rates!.id },
    });
    expect(table.missingSince).toBeNull();
    const ran = await fetchJson("POST", `${app.url}/v1/query`, token, {
      source: source.slug,
      from: "rates",
      select: ["rate"],
    });
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
  });

  it("removes the table, its measures and the metrics using them once nothing elsewhere uses them", async () => {
    const { source, measures, metrics } = await seedCrossTable();
    for (const path of [
      `/${source.id}/metrics/${metrics.roas}`,
      `/${source.id}/measures/${measures.revenue_eur}`,
    ]) {
      expect((await api("DELETE", path, token)).status).toBe(204);
    }
    const removed = await api(
      "DELETE",
      `/${source.id}/tables/${source.tables.rates!.id}`,
      token
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(await namesOf(source.id)).toEqual({ measures: [], metrics: [] });

    const withTable = {
      source_id: source.id,
      removed_with_table: { id: source.tables.rates!.id, name: "rates" },
    };
    const [measureEntry] = (await auditRows(measures.fx_rate!)).filter(
      (e) => e.payload.metadata.event === "zeteo.measure.deleted"
    );
    expect(measureEntry?.payload).toMatchObject({
      action: "DELETE",
      entityType: "measure",
      userId: ownerId,
      metadata: { ...withTable, name: "fx_rate" },
    });
    const [metricEntry] = (await auditRows(metrics.rate_x2!)).filter(
      (e) => e.payload.metadata.event === "zeteo.metric.deleted"
    );
    expect(metricEntry?.payload).toMatchObject({
      action: "DELETE",
      entityType: "metric",
      userId: ownerId,
      metadata: { ...withTable, name: "rate_x2" },
    });
    const sourceEntry = (await auditRows(source.id)).find(
      (e) => e.payload.metadata.event === "zeteo.source.table_removed"
    );
    expect(sourceEntry?.payload.metadata).toMatchObject({
      measures_removed: [{ id: measures.fx_rate, name: "fx_rate" }],
      metrics_removed: [{ id: metrics.rate_x2, name: "rate_x2" }],
    });
  });

  it("deletes the measures and their editors with the source", async () => {
    const source = await seed();
    expect((await create(source.id, "sold", "sales")).status).toBe(201);
    const editors = await api("PUT", `/${source.id}/measure-editors`, token, {
      principals: [{ type: "user", id: randomUUID() }],
    });
    expect(editors.status, JSON.stringify(editors.body)).toBe(200);

    const deleted = await api("DELETE", `/${source.id}`, token);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(await prisma.measure.count({ where: { sourceId: source.id } })).toBe(
      0
    );
    expect(
      await prisma.measureEditor.count({ where: { sourceId: source.id } })
    ).toBe(0);
  });

  it("refuses a saved query using a deleted measure as not accessible", async () => {
    const source = await seed();
    const created = await create(source.id, "sold", "sales");
    const saved = await prisma.savedQuery.create({
      data: {
        ownerId,
        sourceId: source.id,
        name: `sold ${randomUUID().slice(0, 8)}`,
        query: {
          source: source.slug,
          from: "sales",
          select: [{ measure: "sold" }],
        },
      },
    });
    const run = () =>
      fetchJson(
        "POST",
        `${app.url}/v1/saved-queries/${saved.id}/run`,
        token,
        {}
      );
    const ran = await run();
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    expect(Number(ran.body.rows[0][0])).toBe(42);

    const used = await api(
      "GET",
      `/${source.id}/measures/${created.body.id}`,
      token
    );
    expect(used.body.used_by).toEqual({ saved_queries: 1, panels: 0 });
    expect(
      (await api("DELETE", `/${source.id}/measures/${created.body.id}`, token))
        .status
    ).toBe(204);

    const refused = await run();
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("saved_query_not_accessible");
  });
});
