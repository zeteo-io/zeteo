// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStaging } from "../../../../file-sources/staging.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import env from "../../../../env.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  csvOf,
  fileSourcesCall,
  removeFileSourcesOf,
  stageFile,
  storedTables,
} from "../../../support/fileSources.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
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
  fileSourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, otherId, adminId]);
  await removeFileSourcesOf([ownerId, otherId, adminId]);
  await app.close();
});

const zfSchemas = async () =>
  (
    await prisma.$queryRaw<Array<{ n: string }>>`
      SELECT nspname AS n FROM pg_namespace
      WHERE nspname LIKE 'zf\\_%' ORDER BY nspname`
  ).map((r) => r.n);

const ownSources = (id: string) =>
  prisma.source.findMany({ where: { ownerId: id } });

describe("POST /v1/file-sources", () => {
  it("creates a source with its tables, columns and owner grants", async () => {
    const staged = await stageFile(ownerId, ORDERS, "My Orders.csv");
    const res = await call("POST", "", owner, {
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
      stored_bytes: expect.any(Number),
    });
    expect(res.body.stored_bytes).toBeGreaterThan(0);
    expect(res.body.tables).toEqual([
      {
        id: expect.any(String),
        name: "my_orders",
        row_count: 2,
        last_synced_at: expect.any(String),
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

    const tableId = res.body.tables[0].id;
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
      res.body.tables[0].columns.map((c: { name: string; type: string }) => [
        c.name,
        c.type,
      ])
    ).toEqual([
      ["order_id", "text"],
      ["total", "number"],
      ["postcode", "text"],
      ["paid", "boolean"],
    ]);
    expect(res.body.tables[0].name).toBe("orders");
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
      staging_id: staged.stagingId,
      name: "Titled",
      tables: [
        { key: "csv", header_row: 1, columns: [{ index: 2, type: "text" }] },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.tables[0].row_count).toBe(2);
    expect(
      res.body.tables[0].columns.map(
        (c: { name: string; original_name: string; type: string }) => [
          c.name,
          c.original_name,
          c.type,
        ]
      )
    ).toEqual([
      ["id", "id", "number"],
      ["amount", "amount", "number"],
      ["note", "note", "text"],
    ]);
  });

  it("with header_row null, names the columns column_<n> and keeps row 0 as data", async () => {
    const staged = await stageFile(ownerId, ORDERS);
    const res = await call("POST", "", owner, {
      staging_id: staged.stagingId,
      name: "Headless",
      tables: [{ key: "csv", header_row: null }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.tables[0].row_count).toBe(3);
    expect(
      res.body.tables[0].columns.map((c: { name: string; type: string }) => [
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
    const quota = env.FILE_SOURCE_QUOTA_BYTES;
    env.FILE_SOURCE_QUOTA_BYTES = 1;
    try {
      const staged = await stageFile(ownerId, ORDERS);
      const res = await call("POST", "", owner, {
        staging_id: staged.stagingId,
        name: "Over quota",
        tables: [{ key: "csv" }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("quota_exceeded");
    } finally {
      env.FILE_SOURCE_QUOTA_BYTES = quota;
    }
    expect(await ownSources(ownerId)).toEqual(before);
    expect(await zfSchemas()).toEqual(schemasBefore);
  });

  it("answers 409 name_taken for a slug in use", async () => {
    const first = await call("POST", "", owner, {
      staging_id: (await stageFile(ownerId, ORDERS)).stagingId,
      name: "Taken",
      tables: [{ key: "csv" }],
    });
    expect(first.status).toBe(201);
    const res = await call("POST", "", owner, {
      staging_id: (await stageFile(ownerId, ORDERS)).stagingId,
      name: "Taken again",
      slug: first.body.slug,
      tables: [{ key: "csv" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_taken");
    // A slug made from a name in use gets a suffix instead.
    const derived = await call("POST", "", owner, {
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
      staging_id: staged.stagingId,
      name: "Not mine",
      tables: [{ key: "csv" }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("staging_not_found");
  });

  it("answers 403 without zeteo.file_sources.write", async () => {
    const res = await call("POST", "", admin, {
      staging_id: randomUUID(),
      name: "Admin",
      tables: [{ key: "csv" }],
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/file-sources", () => {
  it("lists the caller's own by default, every one with scope=all for an admin", async () => {
    const created = await call("POST", "", other, {
      staging_id: (await stageFile(otherId, ORDERS)).stagingId,
      name: "Other's",
      tables: [{ key: "csv" }],
    });
    expect(created.status).toBe(201);

    const mine = await call("GET", "", other, undefined);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((s: { id: string }) => s.id)).toEqual([
      created.body.id,
    ]);
    expect(mine.body.data[0].stored_bytes).toBeGreaterThan(0);

    const all = await call("GET", "?scope=all", admin, undefined);
    expect(all.status).toBe(200);
    const ids = all.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(created.body.id);
    expect(ids.length).toBeGreaterThan(1);

    const refused = await call("GET", "?scope=all", other, undefined);
    expect(refused.status).toBe(403);
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
