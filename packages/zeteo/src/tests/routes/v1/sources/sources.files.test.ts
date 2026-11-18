// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStaging } from "../../../../uploads/staging.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import env from "../../../../env.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  csvOf,
  uploadTablesOf,
  removeUploadSourcesOf,
  sourcesCall,
  stageFile,
  storedTables,
} from "../../../support/uploads.js";

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

const ORDERS = csvOf(
  ["Order ID", "Total", "Zip", "Paid"],
  [
    ["1", "10.5", "01234", "true"],
    ["2", "20", "02345", "false"],
  ]
);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, otherId, adminId]);
  await removeUploadSourcesOf([ownerId, otherId, adminId]);
  await app.close();
});

const zfSchemas = async () =>
  (
    await prisma.$queryRaw<Array<{ n: string }>>`
      SELECT nspname AS n FROM pg_namespace
      WHERE nspname LIKE 'zu\\_%' ORDER BY nspname`
  ).map((r) => r.n);

const ownSources = (id: string) =>
  prisma.source.findMany({ where: { ownerId: id } });

describe("POST /v1/sources (upload)", () => {
  it("creates a source with its tables, columns and owner grants", async () => {
    const staged = await stageFile(ownerId, ORDERS, "My Orders.csv");
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "My Orders",
      tables: [{ key: "csv" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      slug: expect.stringMatching(/^my-orders/),
      name: "My Orders",
      type: "upload",
      owner_id: ownerId,
      created_at: expect.any(String),
      archived_at: null,
      settings: null,
      size_bytes: expect.any(Number),
      size_measured_at: null,
      share_count: 0,
    });
    expect(res.body).not.toHaveProperty("tables");
    expect(res.body.size_bytes).toBeGreaterThan(0);
    expect(await uploadTablesOf(res.body.id)).toEqual([
      {
        id: expect.any(String),
        name: "my_orders",
        description: null,
        row_count: 2,
        last_loaded_at: expect.any(String),
        missing: false,
        columns: [
          ["order_id", "Order ID", "number"],
          ["total", "Total", "number"],
          ["zip", "Zip", "text"],
          ["paid", "Paid", "boolean"],
        ].map(([name, original, type]) => ({
          id: expect.any(String),
          name,
          original_name: original,
          type,
          description: original,
          missing: false,
        })),
      },
    ]);

    const tableId = (await uploadTablesOf(res.body.id))[0]!.id;

    // The tables' and columns' views carry what an upload says of them.
    const listed = await call("GET", `/${res.body.id}/tables`, owner);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        id: tableId,
        name: "my_orders",
        row_count: 2,
        last_loaded_at: expect.any(String),
      }),
    ]);
    const detail = await call(
      "GET",
      `/${res.body.id}/tables/${tableId}`,
      owner
    );
    expect(detail.status).toBe(200);
    expect(
      detail.body.columns.map((c: { name: string; original_name: string }) => [
        c.name,
        c.original_name,
      ])
    ).toEqual([
      ["order_id", "Order ID"],
      ["total", "Total"],
      ["zip", "Zip"],
      ["paid", "Paid"],
    ]);

    const grants = await prisma.grant.findMany({ where: { tableId } });
    expect(grants).toEqual([
      expect.objectContaining({
        principalType: "user",
        principalId: ownerId,
        allColumns: true,
        ownerGrant: true,
      }),
    ]);
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row).toMatchObject({
      rowCap: 50000,
      exportEnabled: false,
      createdBy: ownerId,
    });
    expect(await storedTables(res.body.id)).toEqual(["my_orders"]);
    // The staging is used up.
    await expect(getStaging(staged.stagingId, ownerId)).rejects.toMatchObject({
      code: "staging_not_found",
    });

    const query = {
      source: res.body.slug,
      from: "my_orders",
      select: ["order_id", "zip"],
      orderBy: [{ order_id: "asc" }],
    };
    const mine = await postQuery(owner, query, app.url);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.rows).toEqual([
      ["1", "01234"],
      ["2", "02345"],
    ]);
    const theirs = await postQuery(other, query, app.url);
    expect(theirs.status).toBe(422);
    expect(theirs.body.error).toBe("not_found_or_not_accessible");
  });

  it("applies corrections: names, types, the tables kept", async () => {
    const staged = await stageFile(ownerId, ORDERS);
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Corrected",
      slug: `corrected-${randomUUID().slice(0, 8)}`,
      tables: [
        {
          key: "csv",
          name: "orders",
          columns: [
            { index: 0, type: "text" },
            { index: 2, name: "postcode" },
          ],
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(
      (await uploadTablesOf(res.body.id))[0]!.columns.map((c) => [
        c.name,
        c.type,
      ])
    ).toEqual([
      ["order_id", "text"],
      ["total", "number"],
      ["postcode", "text"],
      ["paid", "boolean"],
    ]);
    expect((await uploadTablesOf(res.body.id))[0]!.name).toBe("orders");
  });

  it("re-infers the types when the header row differs from the preview's", async () => {
    // Row 0 is a title; the real header is row 1.
    const csv = csvOf(
      ["Report", "", ""],
      [
        ["id", "amount", "note"],
        ["1", "2.5", "x"],
        ["2", "3", "y"],
      ]
    );
    const staged = await stageFile(ownerId, csv);
    expect(staged.tables[0]!.header_row).toBe(0);
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Titled",
      tables: [
        { key: "csv", header_row: 1, columns: [{ index: 2, type: "text" }] },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await uploadTablesOf(res.body.id))[0]!.row_count).toBe(2);
    expect(
      (await uploadTablesOf(res.body.id))[0]!.columns.map((c) => [
        c.name,
        c.original_name,
        c.type,
      ])
    ).toEqual([
      ["id", "id", "number"],
      ["amount", "amount", "number"],
      ["note", "note", "text"],
    ]);
  });

  it("with header_row null, names the columns column_<n> and keeps row 0 as data", async () => {
    const staged = await stageFile(ownerId, ORDERS);
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Headless",
      tables: [{ key: "csv", header_row: null }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await uploadTablesOf(res.body.id))[0]!.row_count).toBe(3);
    expect(
      (await uploadTablesOf(res.body.id))[0]!.columns.map((c) => [
        c.name,
        c.type,
      ])
    ).toEqual([
      ["column_1", "text"],
      ["column_2", "text"],
      ["column_3", "text"],
      ["column_4", "text"],
    ]);
  });

  it("answers 422 cast_failed naming table, column and rows, and creates nothing", async () => {
    const before = await ownSources(ownerId);
    const schemasBefore = await zfSchemas();
    const staged = await stageFile(ownerId, ORDERS);
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Bad cast",
      tables: [{ key: "csv", columns: [{ index: 3, type: "number" }] }],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "cast_failed",
      table: "data",
      column: "paid",
      rows: [2, 3],
    });
    expect(await ownSources(ownerId)).toEqual(before);
    expect(await zfSchemas()).toEqual(schemasBefore);
    // The staging stays for another try.
    await expect(getStaging(staged.stagingId, ownerId)).resolves.toBeTruthy();
  });

  it("answers 409 quota_exceeded and creates nothing", async () => {
    const before = await ownSources(ownerId);
    const schemasBefore = await zfSchemas();
    const quota = env.UPLOAD_QUOTA_BYTES;
    env.UPLOAD_QUOTA_BYTES = 1;
    try {
      const staged = await stageFile(ownerId, ORDERS);
      const res = await call("POST", "", owner, {
        type: "upload",
        staging_id: staged.stagingId,
        name: "Over quota",
        tables: [{ key: "csv" }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("quota_exceeded");
    } finally {
      env.UPLOAD_QUOTA_BYTES = quota;
    }
    expect(await ownSources(ownerId)).toEqual(before);
    expect(await zfSchemas()).toEqual(schemasBefore);
  });

  it("answers 409 name_taken for a slug in use", async () => {
    const first = await call("POST", "", owner, {
      type: "upload",
      staging_id: (await stageFile(ownerId, ORDERS)).stagingId,
      name: "Taken",
      tables: [{ key: "csv" }],
    });
    expect(first.status).toBe(201);
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: (await stageFile(ownerId, ORDERS)).stagingId,
      name: "Taken again",
      slug: first.body.slug,
      tables: [{ key: "csv" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_taken");
    // A slug made from a name in use gets a suffix instead.
    const derived = await call("POST", "", owner, {
      type: "upload",
      staging_id: (await stageFile(ownerId, ORDERS)).stagingId,
      name: "Taken",
      tables: [{ key: "csv" }],
    });
    expect(derived.status).toBe(201);
    expect(derived.body.slug).not.toBe(first.body.slug);
  });

  it.each([
    ["a load-shaped table name", { key: "csv", name: "orders__load_abc" }],
    ["a table key not in the upload", { key: "sheet:nope" }],
    ["a column index out of range", { key: "csv", columns: [{ index: 9 }] }],
    [
      "two columns of one name",
      { key: "csv", columns: [{ index: 1, name: "order_id" }] },
    ],
    ["a header row past the end", { key: "csv", header_row: 50 }],
  ])("answers 400 for %s", async (_, table) => {
    const staged = await stageFile(ownerId, ORDERS);
    const res = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Invalid",
      tables: [table],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("answers 404 staging_not_found for someone else's staging", async () => {
    const staged = await stageFile(ownerId, ORDERS);
    const res = await call("POST", "", other, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Not mine",
      tables: [{ key: "csv" }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("staging_not_found");
  });

  it("answers 403 without zeteo.uploads.write", async () => {
    const res = await call("POST", "", admin, {
      type: "upload",
      staging_id: randomUUID(),
      name: "Admin",
      tables: [{ key: "csv" }],
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/sources (upload)", () => {
  it("lists an owner's own with owner_id=me, given only zeteo.uploads.write, and every one for an admin", async () => {
    const created = await call("POST", "", other, {
      type: "upload",
      staging_id: (await stageFile(otherId, ORDERS)).stagingId,
      name: "Other's",
      tables: [{ key: "csv" }],
    });
    expect(created.status).toBe(201);
    // Someone else's, which the owner must not see.
    const notMine = await call("POST", "", owner, {
      type: "upload",
      staging_id: (await stageFile(ownerId, ORDERS)).stagingId,
      name: "Owner's",
      tables: [{ key: "csv" }],
    });
    expect(notMine.status).toBe(201);

    const mine = await call("GET", "?owner_id=me", other);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data.map((s: { id: string }) => s.id)).toEqual([
      created.body.id,
    ]);
    expect(mine.body.data[0]).toMatchObject({
      type: "upload",
      owner_id: otherId,
      settings: null,
      size_measured_at: null,
    });
    expect(mine.body.data[0].size_bytes).toBeGreaterThan(0);
    // Only the owner's own grant: shared with nobody.
    expect(mine.body.data[0].share_count).toBe(0);

    // A user and a group on its table, the user twice over: two principals.
    const tableId = (await uploadTablesOf(created.body.id))[0]!.id;
    const reader = randomUUID();
    const team = randomUUID();
    await prisma.grant.createMany({
      data: [
        { principalType: "user" as const, principalId: reader, tableId },
        { principalType: "group" as const, principalId: team, tableId },
      ].map((g) => ({ ...g, allColumns: true, createdBy: otherId })),
    });
    const shared = await call("GET", "?owner_id=me", other);
    expect(shared.body.data[0].share_count).toBe(2);
    const one = await call("GET", `/${created.body.id}`, other);
    expect(one.body.share_count).toBe(2);
    await prisma.grant.deleteMany({
      where: { tableId, principalId: { in: [reader, team] } },
    });

    // An admin filters by owner and type.
    const all = await call("GET", `?owner_id=${otherId}&type=upload`, admin);
    expect(all.status).toBe(200);
    expect(all.body.data.map((s: { id: string }) => s.id)).toEqual([
      created.body.id,
    ]);
    const databases = await call(
      "GET",
      `?owner_id=${otherId}&type=postgres`,
      admin
    );
    expect(databases.body.data).toEqual([]);

    // An owner sees nothing else: no list without owner_id=me, nor another's.
    for (const query of ["", "?type=upload", `?owner_id=${ownerId}`]) {
      const refused = await call("GET", query, other);
      expect(refused.status, query).toBe(403);
    }
  });
});

describe("the owner CHECK on sources", () => {
  const base = () => ({
    id: randomUUID(),
    slug: `check-${randomUUID().slice(0, 8)}`,
    name: "Check",
    sealedSettings: {},
    schemas: ["public"],
    createdBy: ownerId,
  });

  it("refuses an upload source without an owner", async () => {
    await expect(
      prisma.source.create({ data: { ...base(), type: "upload" } })
    ).rejects.toThrow(/check|constraint/i);
  });

  it("refuses a postgres source with an owner", async () => {
    await expect(
      prisma.source.create({
        data: { ...base(), type: "postgres", ownerId },
      })
    ).rejects.toThrow(/check|constraint/i);
  });
});
