// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaFor } from "../../../../../../uploads/storage.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { auditRows } from "../../../../../support/sources.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  SOURCES_READ,
  SOURCES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  createUploadSource,
  csvOf,
  removeUploadSourcesOf,
  sourcesCall,
  stageFile,
  uploadTablesOf,
} from "../../../../../support/uploads.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, UPLOADS_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, UPLOADS_WRITE],
});
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, SOURCES_READ, SOURCES_WRITE],
});
const granteeId = randomUUID();
const grantee = tokenFor({ userId: granteeId, permissions: [DATA_READ] });

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, otherId, adminId, granteeId]);
  await prisma.grant.deleteMany({ where: { principalId: granteeId } });
  await removeUploadSourcesOf([ownerId, otherId]);
  await app.close();
});

/** A file source of the owner with tables `east` (sku, qty) and `west` (sku, qty, note). */
const makeSource = async () => {
  const source = await createUploadSource(
    app.url,
    owner,
    ownerId,
    csvOf(["sku", "qty"], [["a", "1"]]),
    { table: "east" }
  );
  const staged = await stageFile(
    ownerId,
    csvOf(["sku", "qty", "note"], [["b", "2", "hi"]]),
    "west.csv"
  );
  const res = await call("POST", `/${source.id}/tables`, owner, {
    staging_id: staged.stagingId,
    tables: [{ key: "csv", name: "west" }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const tables = await uploadTablesOf(source.id);
  return {
    id: source.id,
    slug: source.slug,
    east: tables.find((t) => t.name === "east")!,
    west: tables.find((t) => t.name === "west")!,
  };
};

const body = (east: string, west: string) => ({
  name: "all_stock",
  label_column: "region",
  members: [
    { table_id: east, label: "East" },
    { table_id: west, label: "West" },
  ],
  columns: [
    { name: "sku", from_name: "sku", include: true },
    { name: "quantity", from_name: "qty", include: true },
    { name: "note", from_name: "note", include: false },
  ],
});

const create = async (s: Awaited<ReturnType<typeof makeSource>>) => {
  const res = await call(
    "POST",
    `/${s.id}/merged-tables`,
    owner,
    body(s.east.id, s.west.id)
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string };
};

describe("merged tables", () => {
  it("GET merged-tables/columns gives the union and suggested labels", async () => {
    const s = await makeSource();
    const res = await call(
      "GET",
      `/${s.id}/merged-tables/columns?member=${s.east.id}&member=${s.west.id}`,
      owner
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      columns: [
        {
          name: "sku",
          type: "text",
          types: ["text"],
          members: [s.east.id, s.west.id],
        },
        {
          name: "qty",
          type: "number",
          types: ["number"],
          members: [s.east.id, s.west.id],
        },
        { name: "note", type: "text", types: ["text"], members: [s.west.id] },
      ],
      labels: { [s.east.id]: "data", [s.west.id]: "west" },
    });

    const one = await call(
      "GET",
      `/${s.id}/merged-tables/columns?member=${s.east.id}`,
      owner
    );
    expect(one.status).toBe(400);
    expect(
      (
        await call(
          "GET",
          `/${s.id}/merged-tables/columns?member=${s.east.id}&member=${s.west.id}`,
          other
        )
      ).status
    ).toBe(403);
  });

  it("POST creates the merged table: 201, its detail, the audit entry and the owner's query", async () => {
    const s = await makeSource();
    const made = await create(s);
    expect(made).toMatchObject({
      name: "all_stock",
      kind: "view",
      row_count: 2,
      origin: { kind: "merged", members: 2 },
    });

    const detail = await call("GET", `/${s.id}/tables/${made.id}`, owner);
    expect(detail.status).toBe(200);
    const merged = detail.body.merged;
    expect(merged).toMatchObject({
      label_column: "region",
      members: [
        { table_id: s.east.id, name: "east", label: "East", missing: false },
        { table_id: s.west.id, name: "west", label: "West", missing: false },
      ],
      columns: [
        {
          name: "sku",
          from_name: "sku",
          type: "text",
          members: [s.east.id, s.west.id],
          missing: false,
        },
        {
          name: "quantity",
          from_name: "qty",
          type: "number",
          members: [s.east.id, s.west.id],
          missing: false,
        },
      ],
      available: [{ name: "note", type: "text", members: [s.west.id] }],
      warnings: [],
    });

    const audit = await auditRows(s.id);
    expect(
      audit.find(
        (a) => a.payload.metadata.event === "zeteo.source.merged_table_saved"
      )?.payload.metadata
    ).toMatchObject({
      table: { id: made.id, name: "all_stock" },
      created: true,
    });

    const res = await postQuery(
      owner,
      {
        source: s.slug,
        from: "all_stock",
        select: ["region", "sku", "quantity"],
        orderBy: [{ sku: "asc" }],
      },
      app.url
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toEqual([
      ["East", "a", "1"],
      ["West", "b", "2"],
    ]);
  });

  it("a grantee with a grant on the merged table only can query it", async () => {
    const s = await makeSource();
    const made = await create(s);
    await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: granteeId,
        tableId: made.id,
        allColumns: true,
        createdBy: ownerId,
      },
    });
    const res = await postQuery(
      grantee,
      {
        source: s.slug,
        from: "all_stock",
        select: ["region", { sum: "quantity", as: "total" }],
        groupBy: ["region"],
        orderBy: [{ region: "asc" }],
      },
      app.url
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toEqual([
      ["East", "1"],
      ["West", "2"],
    ]);
    const member = await postQuery(
      grantee,
      { source: s.slug, from: "east", select: ["sku"] },
      app.url
    );
    expect(member.body.error).toBe("not_found_or_not_accessible");
  });

  it("removing a member table is 409 table_in_merged_table", async () => {
    const s = await makeSource();
    await create(s);
    const res = await call("DELETE", `/${s.id}/tables/${s.east.id}`, owner);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "table_in_merged_table",
      merged_table: "all_stock",
    });
  });

  it("PUT …/merged edits it; DELETE drops its view and frees its members", async () => {
    const s = await makeSource();
    const made = await create(s);
    const edit = await call("PUT", `/${s.id}/tables/${made.id}/merged`, owner, {
      ...body(s.east.id, s.west.id),
      columns: [
        { name: "sku", from_name: "sku", include: true },
        { name: "quantity", from_name: "qty", include: false },
        { name: "note", from_name: "note", include: true },
      ],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const detail = await call("GET", `/${s.id}/tables/${made.id}`, owner);
    expect(
      detail.body.columns.map((c: { name: string; missing_since: unknown }) => [
        c.name,
        c.missing_since === null,
      ])
    ).toEqual([
      ["region", true],
      ["sku", true],
      ["note", true],
      ["quantity", false],
    ]);
    expect(
      (
        await call(
          "PUT",
          `/${s.id}/tables/${s.east.id}/merged`,
          owner,
          body(s.east.id, s.west.id)
        )
      ).status
    ).toBe(404);
    expect(
      (
        await call(
          "PUT",
          `/${s.id}/tables/${made.id}/merged`,
          other,
          body(s.east.id, s.west.id)
        )
      ).status
    ).toBe(403);

    const del = await call("DELETE", `/${s.id}/tables/${made.id}`, admin);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const views = await prisma.$queryRaw<{ viewname: string }[]>`
      SELECT viewname FROM pg_views WHERE schemaname = ${schemaFor(s.id)}`;
    expect(views).toEqual([]);
    expect(
      (await uploadTablesOf(s.id)).find((t) => t.name === "all_stock")!.missing
    ).toBe(true);
    expect(
      (await call("DELETE", `/${s.id}/tables/${s.east.id}`, owner)).status
    ).toBe(204);
  });

  it("a merged column renames through PATCH …/columns/:id; its type cannot change there", async () => {
    const s = await makeSource();
    const made = await create(s);
    const merged = (await uploadTablesOf(s.id)).find((t) => t.id === made.id)!;
    const qty = merged.columns.find((c) => c.name === "quantity")!;
    const path = `/${s.id}/tables/${made.id}/columns/${qty.id}`;
    expect((await call("PATCH", path, owner, { type: "text" })).status).toBe(
      400
    );
    const res = await call("PATCH", path, owner, { name: "qty" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await prisma.$queryRawUnsafe<{ qty: unknown }[]>(
      `SELECT "qty" FROM "${schemaFor(s.id)}"."all_stock" ORDER BY "sku"`
    );
    expect(rows.map((r) => Number(r.qty))).toEqual([1, 2]);
  });

  it("a member's retype or reload keeps the merged view (sync-free member changes)", async () => {
    const s = await makeSource();
    await create(s);
    const sku = s.west.columns.find((c) => c.name === "qty")!;
    const res = await call(
      "PATCH",
      `/${s.id}/tables/${s.west.id}/columns/${sku.id}`,
      owner,
      { name: "amount" }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await prisma.$queryRawUnsafe<{ quantity: unknown }[]>(
      `SELECT "quantity" FROM "${schemaFor(s.id)}"."all_stock" ORDER BY "sku"`
    );
    expect(rows.map((r) => Number(r.quantity))).toEqual([1, 2]);
  });
});
