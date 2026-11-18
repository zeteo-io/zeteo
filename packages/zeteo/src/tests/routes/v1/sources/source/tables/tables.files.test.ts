// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../../../support/queries.js";
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
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  createFileSource,
  csvOf,
  fileTablesOf,
  removeFileSourcesOf,
  removeUploadSources,
  seedUploadSource,
  sourcesCall,
  stageFile,
  storedTables,
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

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const nobody = tokenFor({ permissions: [] });
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE, SOURCES_READ, SOURCES_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});

const bodyOf = (res: { body: Record<string, unknown> }) => {
  const { request_id: _, ...rest } = res.body;
  return rest;
};

describe("/v1/sources/:sourceId/tables (file sources)", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let own: Awaited<ReturnType<typeof seedUploadSource>>;
  let others: Awaited<ReturnType<typeof seedUploadSource>>;
  let databaseSourceId: string;

  const patch = (path: string, token: string, body: unknown) =>
    fetchJson("PATCH", `${app.url}/v1/sources${path}`, token, body);
  const get = (path: string, token: string) =>
    fetchJson("GET", `${app.url}/v1/sources${path}`, token);

  beforeAll(async () => {
    app = await startV1Routes();
    own = await seedUploadSource({ ownerId, tables: [CUSTOMERS] });
    others = await seedUploadSource({
      ownerId: randomUUID(),
      tables: [CUSTOMERS],
    });
    databaseSourceId = await registerSource(app.url);
  });
  afterAll(async () => {
    await removeUploadSources([own.id, others.id]);
    await removeSources([databaseSourceId]);
    await app.close();
  });

  it("lets the owner list and read their source's tables", async () => {
    const list = await get(`/${own.id}/tables`, owner);
    expect(list.status).toBe(200);
    expect((list.body.data as { name: string }[]).map((t) => t.name)).toEqual([
      "customers",
    ]);
    const one = await get(
      `/${own.id}/tables/${own.tables.customers!.id}`,
      owner
    );
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      name: "customers",
      row_count: 1,
      last_loaded_at: expect.any(String),
    });
    expect(
      one.body.columns.map((c: { name: string; original_name: string }) => [
        c.name,
        c.original_name,
      ])
    ).toEqual([
      ["id", "id"],
      ["name", "name"],
    ]);
  });

  it("shows last_loaded_at and original_name null on a database source's tables, and row_count null where the database has no estimate (a view)", async () => {
    const list = await get(`/${databaseSourceId}/tables`, admin);
    expect(list.status).toBe(200);
    const tables = list.body.data as { name: string; id: string }[];
    const view = tables.find((t) => t.name === "paid_orders")!;
    expect(view).toMatchObject({ row_count: null, last_loaded_at: null });
    const customers = tables.find((t) => t.name === "customers")!;
    expect(customers).toMatchObject({ last_loaded_at: null });
    const one = await get(`/${databaseSourceId}/tables/${customers.id}`, admin);
    expect(one.body).toMatchObject({ last_loaded_at: null });
    expect(
      (one.body.columns as { original_name: string | null }[]).every(
        (c) => c.original_name === null
      )
    ).toBe(true);
  });

  it("refuses the owner the tables of another source with the very 403 of anyone", async () => {
    const dbTable = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId, name: "customers" },
    });
    for (const path of [
      `/${databaseSourceId}/tables`,
      `/${others.id}/tables`,
      `/${randomUUID()}/tables`,
      `/${databaseSourceId}/tables/${dbTable.id}`,
      `/${others.id}/tables/${others.tables.customers!.id}`,
      `/${databaseSourceId}/tables/${own.tables.customers!.id}`,
    ]) {
      const res = await get(path, owner);
      expect(res.status, path).toBe(403);
      expect(bodyOf(res)).toEqual(bodyOf(await get(path, nobody)));
    }
  });

  it("lets the owner describe their table and its columns", async () => {
    const res = await patch(
      `/${own.id}/tables/${own.tables.customers!.id}`,
      owner,
      {
        description: "Our customers",
        columns: [{ name: "name", description: "Trading name" }],
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Our customers");
  });

  it("refuses the owner on a database source or another owner's file source, as today", async () => {
    const dbTable = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId, name: "customers" },
    });
    const body = { description: "Not yours" };
    for (const path of [
      `/${databaseSourceId}/tables/${dbTable.id}`,
      `/${others.id}/tables/${others.tables.customers!.id}`,
      // A table of the owner's own source, named under another source.
      `/${databaseSourceId}/tables/${own.tables.customers!.id}`,
    ]) {
      const res = await patch(path, owner, body);
      expect(res.status, path).toBe(403);
      expect(bodyOf(res)).toEqual(bodyOf(await patch(path, nobody, body)));
    }
  });

  it("refuses an owner who no longer holds zeteo.file_sources.write", async () => {
    const lapsed = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
    const res = await patch(
      `/${own.id}/tables/${own.tables.customers!.id}`,
      lapsed,
      { description: "Lapsed" }
    );
    expect(res.status).toBe(403);
  });
});

const CSV = csvOf(["id", "name"], [["1", "a"]]);
const MORE = csvOf(
  ["code", "label"],
  [
    ["x", "X"],
    ["y", "Y"],
  ]
);

describe("POST /v1/sources/:sourceId/tables", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let databaseSourceId: string;
  const call = (method: string, path: string, token: string, body?: unknown) =>
    sourcesCall(app.url, method, path, token, body);

  beforeAll(async () => {
    app = await startV1Routes();
    databaseSourceId = await registerSource(app.url);
  });
  afterAll(async () => {
    await removeRunsOf([ownerId]);
    await removeFileSourcesOf([ownerId, adminId, otherId]);
    await removeSources([databaseSourceId]);
    await app.close();
  });

  it("adds tables from a staging, each with an owner grant", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const staged = await stageFile(ownerId, MORE);
    const res = await call("POST", `/${source.id}/tables`, owner, {
      staging_id: staged.stagingId,
      tables: [{ key: "csv", name: "codes" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ id: source.id, type: "upload" });
    const tables = await fileTablesOf(source.id);
    expect(tables.map((t) => t.name)).toEqual(["codes", "data"]);
    const codes = tables.find((t) => t.name === "codes")!;
    expect(codes.row_count).toBe(2);
    expect(await storedTables(source.id)).toEqual(["codes", "data"]);
    expect(
      await prisma.grant.findMany({ where: { tableId: codes.id } })
    ).toEqual([
      expect.objectContaining({ principalId: ownerId, ownerGrant: true }),
    ]);
    const q = await postQuery(
      owner,
      {
        source: source.slug,
        from: "codes",
        select: ["code"],
        orderBy: [{ code: "asc" }],
      },
      app.url
    );
    expect(q.body.rows).toEqual([["x"], ["y"]]);
  });

  it("gives an admin's added table to the owner, not the admin", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const res = await call("POST", `/${source.id}/tables`, admin, {
      staging_id: (await stageFile(adminId, MORE)).stagingId,
      tables: [{ key: "csv", name: "codes" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const codes = (await fileTablesOf(source.id)).find(
      (t) => t.name === "codes"
    )!;
    expect(
      (await prisma.grant.findMany({ where: { tableId: codes.id } })).map(
        (g) => g.principalId
      )
    ).toEqual([ownerId]);
  });

  it("answers 409 name_taken for a table name the source has", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const res = await call("POST", `/${source.id}/tables`, owner, {
      staging_id: (await stageFile(ownerId, MORE)).stagingId,
      tables: [{ key: "csv", name: "data" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_taken");
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("answers someone else as it answers anyone without the permission", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const body = {
      staging_id: (await stageFile(otherId, MORE)).stagingId,
      tables: [{ key: "csv", name: "codes" }],
    };
    const res = await call("POST", `/${source.id}/tables`, other, body);
    expect(res.status).toBe(403);
    expect(bodyOf(res)).toEqual(
      bodyOf(await call("POST", `/${source.id}/tables`, nobody, body))
    );
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("answers 409 not_an_upload_source on a database source", async () => {
    const res = await call("POST", `/${databaseSourceId}/tables`, admin, {
      staging_id: (await stageFile(adminId, MORE)).stagingId,
      tables: [{ key: "csv", name: "codes" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_an_upload_source");
  });
});
