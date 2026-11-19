// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageSheets } from "../../../../uploads/staging.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  csvOf,
  removeUploadSourcesOf,
  schemaExists,
  sourcesCall,
  stageFile,
  uploadTablesOf,
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

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, otherId]);
  await removeUploadSourcesOf([ownerId, otherId]);
  await app.close();
});

/** A spreadsheet id no other test uses. */
const newSheetId = () => `sheet-${randomUUID()}`;

const ORDER_ROWS = [
  ["Order ID", "Total"],
  ["1", "10.5"],
  ["2", "20"],
];

/** Stages a spreadsheet with the given tabs (sheetId, name, rows) for `userId`. */
const stage = (
  userId: string,
  id: string,
  tabs: { sheetId: number; name: string; rows: (string | null)[][] }[] = [
    { sheetId: 11, name: "Orders", rows: ORDER_ROWS },
  ]
) =>
  stageSheets({
    ownerId: userId,
    spreadsheet: {
      id,
      title: "Book",
      tabs: tabs.map((t) => ({ ...t, kind: "sheet" as const })),
    },
  });

const createFrom = (
  token: string,
  stagingId: string,
  key: string,
  extra: Record<string, unknown> = {}
) =>
  call("POST", "", token, {
    type: "upload",
    staging_id: stagingId,
    name: "Book",
    tables: [{ key }],
    ...extra,
  });

describe("POST /v1/sources (google-sheets)", () => {
  it("creates a Sheets source from a link staging; owner grants, zu_ schema, tables queryable", async () => {
    const sheet = newSheetId();
    const staged = await stage(ownerId, sheet);
    const res = await createFrom(owner, staged.stagingId, "sheet:11", {
      slug: `book-${randomUUID().slice(0, 8)}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      type: "upload",
      owner_id: ownerId,
      settings: null,
    });
    expect(await schemaExists(res.body.id)).toBe(true);

    const row = await prisma.source.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row).toMatchObject({ type: "upload", syncIntervalMinutes: 60 });
    expect(row.lastRefreshedAt).toBeInstanceOf(Date);
    expect(row.lastSyncAttemptAt).toBeInstanceOf(Date);

    const tables = await prisma.sourceTable.findMany({
      where: { sourceId: res.body.id },
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]!.origin).toMatchObject({
      kind: "google-sheets",
      spreadsheetId: sheet,
      sheetId: 11,
      headerRow: 0,
    });
    const grants = await prisma.grant.findMany({
      where: { tableId: tables[0]!.id },
    });
    expect(grants).toEqual([
      expect.objectContaining({
        principalId: ownerId,
        ownerGrant: true,
        allColumns: true,
      }),
    ]);

    const q = await postQuery(
      owner,
      {
        source: res.body.slug,
        from: "orders",
        select: ["order_id", "total"],
        orderBy: [{ order_id: "asc" }],
      },
      app.url
    );
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.rows).toEqual([
      ["1", "10.5"],
      ["2", "20"],
    ]);

    const audit = await prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM "core"."core_outbox"
      WHERE payload::text LIKE ${`%${sheet}%`}`;
    expect(audit.length).toBeGreaterThan(0);
  });

  it("two creates from two stagings of one spreadsheet: one 201, one 409 sheet_in_use", async () => {
    const sheet = newSheetId();
    const [a, b] = await Promise.all([
      stage(ownerId, sheet),
      stage(otherId, sheet),
    ]);
    const results = await Promise.all([
      createFrom(owner, a.stagingId, "sheet:11"),
      createFrom(other, b.stagingId, "sheet:11"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error).toBe("sheet_in_use");
    const claimed = await prisma.source.findMany({
      where: {
        archivedAt: null,
        tables: {
          some: { origin: { path: ["spreadsheetId"], equals: sheet } },
        },
      },
    });
    expect(claimed).toHaveLength(1);
    const claims = await prisma.uploadClaim.findMany({
      where: { fileId: sheet },
    });
    expect(claims.map((c) => [c.vendor, c.sourceId])).toEqual([
      ["google-sheets", claimed[0]!.id],
    ]);
  });

  it("a Sheets staging creates an upload source with a claim", async () => {
    const sheet = newSheetId();
    const res = await createFrom(
      owner,
      (await stage(ownerId, sheet)).stagingId,
      "sheet:11"
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe("upload");
    expect(
      await prisma.uploadClaim.findMany({ where: { sourceId: res.body.id } })
    ).toEqual([expect.objectContaining({ fileId: sheet })]);
  });

  it("a file staging creates an upload source, keeping sync_interval_minutes for later Sheets tables", async () => {
    const fileStaged = await stageFile(ownerId, csvOf(["a"], [["1"]]), "a.csv");
    const res = await createFrom(owner, fileStaged.stagingId, "csv", {
      sync_interval_minutes: 30,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe("upload");
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.syncIntervalMinutes).toBe(30);
    const [table] = await prisma.sourceTable.findMany({
      where: { sourceId: res.body.id },
    });
    expect(table!.origin).toEqual({ kind: "file", filename: "a.csv" });
    expect(
      await prisma.uploadClaim.count({ where: { sourceId: res.body.id } })
    ).toBe(0);

    // Its first Sheets tables keep the interval given at create.
    const added = await call("POST", `/${res.body.id}/tables`, owner, {
      staging_id: (await stage(ownerId, newSheetId())).stagingId,
      tables: [{ key: "sheet:11" }],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const after = await prisma.source.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(after.syncIntervalMinutes).toBe(30);
  });

  it("after delete, the spreadsheet can be claimed again", async () => {
    const sheet = newSheetId();
    const first = await createFrom(
      owner,
      (await stage(ownerId, sheet)).stagingId,
      "sheet:11"
    );
    expect(first.status).toBe(201);
    const del = await call("DELETE", `/${first.body.id}`, owner);
    expect(del.status).toBe(204);
    const again = await createFrom(
      owner,
      (await stage(ownerId, sheet)).stagingId,
      "sheet:11"
    );
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("add tabs: a new tab is added; an already-added tab is 409 tab_already_added", async () => {
    const sheet = newSheetId();
    const tabs = [
      { sheetId: 11, name: "Orders", rows: ORDER_ROWS },
      { sheetId: 22, name: "Items", rows: [["Sku"], ["a"]] },
    ];
    const created = await createFrom(
      owner,
      (await stage(ownerId, sheet, tabs)).stagingId,
      "sheet:11"
    );
    expect(created.status).toBe(201);

    const added = await call("POST", `/${created.body.id}/tables`, owner, {
      staging_id: (await stage(ownerId, sheet, tabs)).stagingId,
      tables: [{ key: "sheet:22" }],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const names = (await uploadTablesOf(created.body.id)).map((t) => t.name);
    expect(names).toEqual(["items", "orders"]);
    const items = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: created.body.id, name: "items" },
    });
    expect(items.origin).toMatchObject({
      kind: "google-sheets",
      spreadsheetId: sheet,
      sheetId: 22,
      headerRow: 0,
    });

    const dup = await call("POST", `/${created.body.id}/tables`, owner, {
      staging_id: (await stage(ownerId, sheet, tabs)).stagingId,
      tables: [{ key: "sheet:22", name: "items_two" }],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("tab_already_added");
  });

  it("re-upload of a Sheets table is 409 not_a_file_upload; of a file table works", async () => {
    const fileStaged = await stageFile(
      ownerId,
      csvOf(["Order ID", "Total"], [["1", "1"]]),
      "o.csv"
    );
    const created = await createFrom(owner, fileStaged.stagingId, "csv", {
      tables: [{ key: "csv", name: "book" }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const added = await call("POST", `/${created.body.id}/tables`, owner, {
      staging_id: (await stage(ownerId, newSheetId())).stagingId,
      tables: [{ key: "sheet:11", name: "sheet_orders" }],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const byName = Object.fromEntries(
      (await uploadTablesOf(created.body.id)).map((t) => [t.name, t.id])
    );
    const reupload = async (tableId: string) =>
      call("PUT", `/${created.body.id}/tables/${tableId}`, owner, {
        staging_id: (
          await stageFile(
            ownerId,
            csvOf(["Order ID", "Total"], [["9", "9"]]),
            "o2.csv"
          )
        ).stagingId,
        key: "csv",
      });

    const sheets = await reupload(byName.sheet_orders!);
    expect(sheets.status, JSON.stringify(sheets.body)).toBe(409);
    expect(sheets.body.error).toBe("not_a_file_upload");
    expect(sheets.body.error_description).toBe(
      "This table syncs from Google Sheets; use Sync now."
    );

    const file = await reupload(byName.book!);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    const table = await prisma.sourceTable.findUniqueOrThrow({
      where: { id: byName.book! },
    });
    expect(table.origin).toEqual({ kind: "file", filename: "o2.csv" });
  });

  it("re-upload of a file table from a Sheets staging is 409 not_a_file_upload", async () => {
    const fileStaged = await stageFile(ownerId, csvOf(["a"], [["1"]]), "a.csv");
    const created = await createFrom(owner, fileStaged.stagingId, "csv");
    expect(created.status).toBe(201);
    const [table] = await uploadTablesOf(created.body.id);
    const res = await call(
      "PUT",
      `/${created.body.id}/tables/${table!.id}`,
      owner,
      {
        staging_id: (await stage(ownerId, newSheetId())).stagingId,
        key: "sheet:11",
      }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("not_a_file_upload");
  });
});
