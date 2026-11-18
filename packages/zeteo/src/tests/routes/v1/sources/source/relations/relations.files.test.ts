// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { registerSource } from "../../../../../support/grants.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  removeUploadSources,
  seedUploadSource,
  type UploadTableSpec,
} from "../../../../../support/fileSources.js";

const CUSTOMERS: UploadTableSpec = {
  name: "customers",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "text" },
  ],
  rows: [["1", "Acme"]],
};
const ORDERS: UploadTableSpec = {
  name: "orders",
  columns: [
    { name: "id", type: "number" },
    { name: "customer_id", type: "number" },
  ],
  rows: [["10", "1"]],
};

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const admin = tokenFor({ permissions: [SOURCES_WRITE] });
const nobody = tokenFor({ permissions: [] });

const bodyOf = (res: { body: Record<string, unknown> }) => {
  const { request_id: _, ...rest } = res.body;
  return rest;
};

describe("/v1/sources/:sourceId/relations (file sources)", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let own: Awaited<ReturnType<typeof seedUploadSource>>;
  let others: Awaited<ReturnType<typeof seedUploadSource>>;
  let databaseSourceId: string;

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/sources${path}`, token, body);
  const declare = (source: typeof own, name = "customer") => ({
    name,
    from_table_id: source.tables.orders!.id,
    from_columns: ["customer_id"],
    to_table_id: source.tables.customers!.id,
    to_columns: ["id"],
    to_many: false,
  });

  beforeAll(async () => {
    app = await startV1Routes();
    own = await seedUploadSource({ ownerId, tables: [CUSTOMERS, ORDERS] });
    others = await seedUploadSource({
      ownerId: randomUUID(),
      tables: [CUSTOMERS, ORDERS],
    });
    databaseSourceId = await registerSource(app.url);
  });
  afterAll(async () => {
    await removeUploadSources([own.id, others.id]);
    await removeSources([databaseSourceId]);
    await app.close();
  });

  it("lets the owner declare, rename and remove a relation between their tables", async () => {
    const made = await call(
      "POST",
      `/${own.id}/relations`,
      owner,
      declare(own)
    );
    expect(made.status).toBe(201);
    const path = `/${own.id}/relations/${made.body.id}`;
    const renamed = await call("PATCH", path, owner, { name: "buyer" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("buyer");
    expect((await call("DELETE", path, owner)).status).toBe(204);
  });

  it("keeps a relation within one source", async () => {
    const res = await call("POST", `/${own.id}/relations`, owner, {
      ...declare(own),
      to_table_id: others.tables.customers!.id,
    });
    expect(res.status).toBe(422);
  });

  it("refuses the owner on a database source or another owner's file source, as today", async () => {
    const dbOrders = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId, name: "orders" },
    });
    const dbCustomers = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId, name: "customers" },
    });
    const cases = [
      {
        id: databaseSourceId,
        body: {
          name: "by_region",
          from_table_id: dbOrders.id,
          from_columns: ["status"],
          to_table_id: dbCustomers.id,
          to_columns: ["region"],
          to_many: false,
        },
      },
      { id: others.id, body: declare(others) },
    ];
    for (const { id, body } of cases) {
      const made = await call("POST", `/${id}/relations`, admin, body);
      expect(made.status).toBe(201);
      const attempts = [
        ["POST", `/${id}/relations`, body],
        ["PATCH", `/${id}/relations/${made.body.id}`, { name: "other" }],
        ["DELETE", `/${id}/relations/${made.body.id}`, undefined],
      ] as const;
      for (const [method, path, payload] of attempts) {
        const res = await call(method, path, owner, payload);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(bodyOf(res)).toEqual(
          bodyOf(await call(method, path, nobody, payload))
        );
      }
    }
  });

  it("refuses an owner who no longer holds zeteo.file_sources.write", async () => {
    const lapsed = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
    const res = await call(
      "POST",
      `/${own.id}/relations`,
      lapsed,
      declare(own, "lapsed")
    );
    expect(res.status).toBe(403);
  });
});
