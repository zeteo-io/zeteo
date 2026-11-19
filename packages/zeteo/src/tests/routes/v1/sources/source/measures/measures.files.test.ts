// @module-tag int
// @module-tag platform
import { measureBody, sourcesApi } from "../../../../../support/measures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeRunsOf } from "../../../../../support/queries.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MEASURES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
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
