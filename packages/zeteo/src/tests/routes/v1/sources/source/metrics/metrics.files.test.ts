// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeRunsOf } from "../../../../../support/queries.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { auditRows } from "../../../../../support/sources.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
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

const table = (name: string, rows: string[][]) => ({
  name,
  columns: [
    { name: "id", type: "number" as const },
    { name: "amount", type: "number" as const },
  ],
  rows,
});
const TABLES = [
  table("sales", [
    ["1", "10"],
    ["2", "32"],
  ]),
  table("returns", [["1", "4"]]),
];

describe("/v1/sources/:sourceId/metrics: upload sources", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const api = sourcesApi(() => app.url);
  const ownerId = randomUUID();
  const token = tokenFor({
    userId: ownerId,
    permissions: [UPLOADS_WRITE, DATA_READ, MEASURES_WRITE],
  });

  /** An upload source with sold (sales), returned (returns), and metrics over them. */
  const seed = async () => {
    const source = await seedUploadSource({ ownerId, tables: TABLES });
    await createMeasures(app.url, source.id, token, [
      { ...measureBody("sold", { sum: "amount" }), table: "sales" },
      { ...measureBody("returned", { sum: "amount" }), table: "returns" },
    ]);
    await createMetrics(app.url, source.id, token, [
      metricBody("net", {
        sub: [{ measure: "sold" }, { measure: "returned" }],
      }),
      metricBody("return_rate", { div: [{ measure: "returned" }, 100] }),
    ]);
    return source;
  };

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeRunsOf([ownerId]);
    await removeUploadSourcesOf([ownerId]);
    await app.close();
  });

  it("deletes the metrics using a removed table's measures, and only those", async () => {
    const source = await seed();
    const removed = await api(
      "DELETE",
      `/${source.id}/tables/${source.tables.sales!.id}`,
      token
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    const left = await prisma.metric.findMany({
      where: { sourceId: source.id },
    });
    expect(left.map((m) => m.name)).toEqual(["return_rate"]);
    const entry = (await auditRows(source.id)).find(
      (e) => e.payload.metadata?.event === "zeteo.source.table_removed"
    );
    expect(entry?.payload.metadata.metrics_removed).toEqual([
      { id: expect.any(String), name: "net" },
    ]);
  });

  it("deletes every metric with the source", async () => {
    const source = await seed();
    const deleted = await api("DELETE", `/${source.id}`, token);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(await prisma.metric.count({ where: { sourceId: source.id } })).toBe(
      0
    );
  });
});
