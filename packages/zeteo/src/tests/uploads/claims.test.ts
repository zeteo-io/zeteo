// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SheetInUseError } from "../../utils/errors.js";
import { stageSheets } from "../../uploads/staging.js";
import { removeRunsOf } from "../support/queries.js";
import { startV1Routes } from "../support/v1App.js";
import { prisma } from "../../utils/db/prisma.js";
import { tokenFor } from "../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  assertSheetUnclaimed,
  claimSpreadsheet,
  releaseUnusedClaims,
} from "../../uploads/claims.js";
import {
  csvOf,
  removeUploadSourcesOf,
  sourcesCall,
  stageFile,
  uploadTablesOf,
} from "../support/uploads.js";

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

const newSheetId = () => `sheet-${randomUUID()}`;

/** Stages a spreadsheet of two tabs (sheetIds 11 and 22) for `userId`. */
const stage = (userId: string, id: string, title = "Book") =>
  stageSheets({
    ownerId: userId,
    spreadsheet: {
      id,
      title,
      tabs: [
        {
          sheetId: 11,
          name: "Orders",
          kind: "sheet" as const,
          rows: [["Order ID"], ["1"]],
        },
        {
          sheetId: 22,
          name: "Items",
          kind: "sheet" as const,
          rows: [["Sku"], ["a"]],
        },
      ],
    },
  });

/** A file upload source of `userId`, with one table `data`. */
const fileSource = async (token: string, userId: string) => {
  const staged = await stageFile(userId, csvOf(["a"], [["1"]]), "numbers.csv");
  const res = await call("POST", "", token, {
    type: "upload",
    staging_id: staged.stagingId,
    name: "Numbers",
    tables: [{ key: "csv", name: "data" }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

/** Adds the tab `key` of the spreadsheet `sheet` to the source as `name`. */
const addTab = async (
  token: string,
  userId: string,
  sourceId: string,
  sheet: string,
  key: string,
  name: string
) =>
  call("POST", `/${sourceId}/tables`, token, {
    staging_id: (await stage(userId, sheet)).stagingId,
    tables: [{ key, name }],
  });

const claimsOf = (sourceId: string) =>
  prisma.uploadClaim.findMany({
    where: { sourceId },
    orderBy: { fileId: "asc" },
  });

describe("mixed upload sources", () => {
  it("a source created from a file then given tabs of two spreadsheets holds all three", async () => {
    const id = await fileSource(owner, ownerId);
    const [a, b] = [newSheetId(), newSheetId()];
    const first = await addTab(owner, ownerId, id, a, "sheet:11", "a_orders");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await addTab(owner, ownerId, id, b, "sheet:22", "b_items");
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const tables = await prisma.sourceTable.findMany({
      where: { sourceId: id },
      orderBy: { name: "asc" },
    });
    expect(tables.map((t) => [t.name, t.origin])).toEqual([
      [
        "a_orders",
        expect.objectContaining({
          kind: "google-sheets",
          spreadsheetId: a,
          sheetId: 11,
        }),
      ],
      [
        "b_items",
        expect.objectContaining({
          kind: "google-sheets",
          spreadsheetId: b,
          sheetId: 22,
        }),
      ],
      ["data", { kind: "file", filename: "numbers.csv" }],
    ]);
    expect((await claimsOf(id)).map((c) => [c.vendor, c.fileId])).toEqual(
      [
        ["google-sheets", a],
        ["google-sheets", b],
      ].sort((x, y) => x[1]!.localeCompare(y[1]!))
    );
    // The first Sheets tables start the source's syncs.
    const row = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(row.syncIntervalMinutes).toBe(60);
  });

  it("adding a tab of a spreadsheet claimed by another source is 409 sheet_in_use without the owner", async () => {
    const sheet = newSheetId();
    const theirs = await fileSource(other, otherId);
    expect(
      (await addTab(other, otherId, theirs, sheet, "sheet:11", "orders")).status
    ).toBe(201);
    const mine = await fileSource(owner, ownerId);
    const res = await addTab(owner, ownerId, mine, sheet, "sheet:22", "items");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("sheet_in_use");
    expect(JSON.stringify(res.body)).not.toContain(otherId);
    expect(JSON.stringify(res.body)).not.toContain(theirs);
    expect((await uploadTablesOf(mine)).map((t) => t.name)).toEqual(["data"]);
  });

  it("adding a second tab of a spreadsheet this source already uses is allowed", async () => {
    const sheet = newSheetId();
    const id = await fileSource(owner, ownerId);
    expect(
      (await addTab(owner, ownerId, id, sheet, "sheet:11", "orders")).status
    ).toBe(201);
    const res = await addTab(owner, ownerId, id, sheet, "sheet:22", "items");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await claimsOf(id)).toHaveLength(1);
  });

  it("two sources racing to claim one spreadsheet: one 201, one 409", async () => {
    const sheet = newSheetId();
    const a = await fileSource(owner, ownerId);
    const b = await fileSource(other, otherId);
    const [sa, sb] = await Promise.all([
      stage(ownerId, sheet),
      stage(otherId, sheet),
    ]);
    const results = await Promise.all([
      call("POST", `/${a}/tables`, owner, {
        staging_id: sa.stagingId,
        tables: [{ key: "sheet:11" }],
      }),
      call("POST", `/${b}/tables`, other, {
        staging_id: sb.stagingId,
        tables: [{ key: "sheet:11" }],
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe(
      "sheet_in_use"
    );
    const claims = await prisma.uploadClaim.findMany({
      where: { fileId: sheet },
    });
    expect(claims).toHaveLength(1);
    const tables = await prisma.sourceTable.findMany({
      where: { origin: { path: ["spreadsheetId"], equals: sheet } },
    });
    expect(tables.map((t) => t.sourceId)).toEqual([claims[0]!.sourceId]);
  });

  it("removing the last table of a spreadsheet releases its claim (another source can then claim it)", async () => {
    const sheet = newSheetId();
    const id = await fileSource(owner, ownerId);
    for (const [key, name] of [
      ["sheet:11", "orders"],
      ["sheet:22", "items"],
    ] as const) {
      expect((await addTab(owner, ownerId, id, sheet, key, name)).status).toBe(
        201
      );
    }
    const byName = Object.fromEntries(
      (await uploadTablesOf(id)).map((t) => [t.name, t.id])
    );
    const del = (tableId: string) =>
      call("DELETE", `/${id}/tables/${tableId}`, owner);

    expect((await del(byName.orders!)).status).toBe(204);
    expect(await claimsOf(id)).toHaveLength(1);
    const blocked = await fileSource(other, otherId);
    expect(
      (await addTab(other, otherId, blocked, sheet, "sheet:11", "orders"))
        .status
    ).toBe(409);

    expect((await del(byName.items!)).status).toBe(204);
    expect(await claimsOf(id)).toHaveLength(0);
    const res = await addTab(other, otherId, blocked, sheet, "sheet:11", "o");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("deleting a Sheets table a sync marked missing marks it removed and releases an all-missing spreadsheet", async () => {
    const sheet = newSheetId();
    const id = await fileSource(owner, ownerId);
    expect(
      (await addTab(owner, ownerId, id, sheet, "sheet:11", "orders")).status
    ).toBe(201);
    const orders = (await uploadTablesOf(id)).find((t) => t.name === "orders")!;
    // As a sync leaves a table whose tab was deleted in Sheets.
    const now = new Date();
    await prisma.$executeRawUnsafe(
      `DROP TABLE "zu_${id.replaceAll("-", "")}"."orders"`
    );
    await prisma.sourceTable.update({
      where: { id: orders.id },
      data: { missingSince: now },
    });
    await prisma.sourceColumn.updateMany({
      where: { tableId: orders.id },
      data: { missingSince: now },
    });
    expect(await claimsOf(id)).toHaveLength(1);

    expect(
      (await call("DELETE", `/${id}/tables/${orders.id}`, other)).status
    ).toBe(403);
    const res = await call("DELETE", `/${id}/tables/${orders.id}`, owner);
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const row = await prisma.sourceTable.findUniqueOrThrow({
      where: { id: orders.id },
    });
    expect(row.origin).toMatchObject({ kind: "google-sheets", removed: true });
    expect(row.missingSince).toEqual(now);
    expect(await claimsOf(id)).toHaveLength(0);
    // Once removed, it is gone for good.
    expect(
      (await call("DELETE", `/${id}/tables/${orders.id}`, owner)).status
    ).toBe(404);
  });

  it("deleting the source releases its claims", async () => {
    const sheet = newSheetId();
    const id = await fileSource(owner, ownerId);
    expect(
      (await addTab(owner, ownerId, id, sheet, "sheet:11", "orders")).status
    ).toBe(201);
    expect((await call("DELETE", `/${id}`, owner)).status).toBe(204);
    expect(await claimsOf(id)).toHaveLength(0);
    const theirs = await fileSource(other, otherId);
    const res = await addTab(other, otherId, theirs, sheet, "sheet:11", "o");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("transfer keeps the source's claims", async () => {
    const sheet = newSheetId();
    const id = await fileSource(owner, ownerId);
    expect(
      (await addTab(owner, ownerId, id, sheet, "sheet:11", "orders")).status
    ).toBe(201);
    await prisma.source.update({ where: { id }, data: { ownerId: otherId } });
    expect((await claimsOf(id)).map((c) => c.fileId)).toEqual([sheet]);
  });

  it("removing a table a live merged table uses is 409 table_in_merged_table naming it", async () => {
    const id = await fileSource(owner, ownerId);
    const [member] = await uploadTablesOf(id);
    const merged = await prisma.sourceTable.create({
      data: {
        sourceId: id,
        schemaName: `zu_${id.replaceAll("-", "")}`,
        name: "all_data",
        kind: "view",
        origin: {
          kind: "merged",
          definition: {
            labelColumnId: randomUUID(),
            members: [{ tableId: member!.id, label: "Numbers" }],
            columns: [],
          },
        },
      },
    });
    const res = await call("DELETE", `/${id}/tables/${member!.id}`, owner);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "table_in_merged_table",
      merged_table: "all_data",
    });
    expect((await uploadTablesOf(id))[0]!.missing).toBe(false);

    // A merged table that is itself gone holds nothing back.
    await prisma.sourceTable.update({
      where: { id: merged.id },
      data: { missingSince: new Date() },
    });
    expect(
      (await call("DELETE", `/${id}/tables/${member!.id}`, owner)).status
    ).toBe(204);
  });
});

describe("claims", () => {
  it("claimSpreadsheet: the same source again is a no-op; another source is SheetInUseError", async () => {
    const sheet = newSheetId();
    const a = await fileSource(owner, ownerId);
    const b = await fileSource(owner, ownerId);
    await prisma.$transaction((tx) => claimSpreadsheet(tx, a, sheet));
    await prisma.$transaction((tx) => claimSpreadsheet(tx, a, sheet));
    await expect(
      prisma.$transaction((tx) => claimSpreadsheet(tx, b, sheet))
    ).rejects.toBeInstanceOf(SheetInUseError);
    expect(await claimsOf(a)).toHaveLength(1);
    expect(await claimsOf(b)).toHaveLength(0);
  });

  it("assertSheetUnclaimed: free and the source's own claim pass; another's is SheetInUseError", async () => {
    const sheet = newSheetId();
    const a = await fileSource(owner, ownerId);
    await assertSheetUnclaimed(sheet);
    await prisma.$transaction((tx) => claimSpreadsheet(tx, a, sheet));
    await assertSheetUnclaimed(sheet, a);
    await expect(assertSheetUnclaimed(sheet)).rejects.toBeInstanceOf(
      SheetInUseError
    );
    await expect(
      assertSheetUnclaimed(sheet, randomUUID())
    ).rejects.toBeInstanceOf(SheetInUseError);
  });

  it("releaseUnusedClaims keeps a claim while a table not removed by its owner uses it", async () => {
    const sheet = newSheetId();
    const id = await fileSource(owner, ownerId);
    expect(
      (await addTab(owner, ownerId, id, sheet, "sheet:11", "orders")).status
    ).toBe(201);
    const orphan = newSheetId();
    await prisma.$transaction((tx) => claimSpreadsheet(tx, id, orphan));
    await prisma.$transaction((tx) => releaseUnusedClaims(tx, id));
    expect((await claimsOf(id)).map((c) => c.fileId)).toEqual([sheet]);
  });
});
