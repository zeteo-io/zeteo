// @module-tag int
// @module-tag platform
import { removeUploadSourcesOf, uploadTablesOf } from "../support/uploads.js";
import { postQuery, removeRunsOf } from "../support/queries.js";
import { presentSourceById } from "../../sources/present.js";
import { syncSheetsSource } from "../../uploads/sync.js";
import { LOAD_LOCKING } from "../../uploads/loading.js";
import type { Caller } from "../../middleware/auth.js";
import { schemaFor } from "../../uploads/storage.js";
import { storedTables } from "../support/uploads.js";
import { startV1Routes } from "../support/v1App.js";
import { prisma } from "../../utils/db/prisma.js";
import { tokenFor } from "../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  FakeSpreadsheet,
  serveSheets,
  stageFakeSheet,
} from "../support/googleSheets.js";
import {
  addTables,
  changeColumn,
  createUploadSource,
  removeTable,
} from "../../uploads/service.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const google = vi.hoisted(() => ({
  getSpreadsheet: vi.fn(),
  googleClient: vi.fn(),
}));

vi.mock("../../google/handler.js", () => ({
  googleClient: () => google.googleClient(),
  sheetsApi: {
    getSpreadsheet: (...args: unknown[]) => google.getSpreadsheet(...args),
  },
  stopGoogleHandler: vi.fn(),
}));

const ownerId = randomUUID();
const granteeId = randomUUID();
const owner: Caller = {
  userId: ownerId,
  organizationId: null,
  permissions: [DATA_READ, UPLOADS_WRITE],
  isServiceAccount: false,
};

const sheets = new Map<string, FakeSpreadsheet>();
let app: Awaited<ReturnType<typeof startV1Routes>>;

beforeAll(async () => {
  app = await startV1Routes();
});
beforeEach(() => {
  serveSheets(google, sheets);
});
afterEach(async () => {
  sheets.clear();
  await prisma.grant.deleteMany({ where: { principalId: granteeId } });
  await removeUploadSourcesOf([ownerId]);
});
afterAll(async () => {
  await removeRunsOf([granteeId]);
  await prisma.source.deleteMany({ where: { createdBy: ownerId } });
  await app.close();
});

const costs = () => ({
  sheetId: 1,
  title: "Costs",
  rows: [
    ["item", "amount"],
    ["rent", "1200"],
  ] as (string | null)[][],
});

/** A Sheets source of `owner` made through create from `tabs`, every tab a table. */
const makeSource = async (tabs = [costs()]) => {
  const sheet = new FakeSpreadsheet(`sheet-${randomUUID()}`, tabs);
  sheets.set(sheet.id, sheet);
  const staged = await stageFakeSheet(ownerId, sheet);
  const view = await createUploadSource(owner, {
    type: "upload",
    staging_id: staged.stagingId,
    name: "Book",
    tables: tabs.map((t) => ({ key: `sheet:${t.sheetId}` })),
  });
  return { sheet, id: view.id };
};

/** The stored table's rows as JSON (numbers as numbers), in load order. */
const storedRows = async (sourceId: string, table: string) =>
  (
    await prisma.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(
      `SELECT to_jsonb(t) AS r FROM "${schemaFor(sourceId)}"."${table}" t`
    )
  ).map((x) => x.r);

const tableNamed = async (sourceId: string, name: string) =>
  (await uploadTablesOf(sourceId)).find((t) => t.name === name)!;

describe("syncSheetsSource", () => {
  it("sync loads new rows and keeps column ids, grants and types", async () => {
    const { sheet, id } = await makeSource();
    const before = await tableNamed(id, "costs");
    const amount = before.columns.find((c) => c.name === "amount")!;
    expect(amount.type).toBe("number");
    await changeColumn(owner, id, before.id, amount.id, { type: "text" });
    const grant = await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: granteeId,
        tableId: before.id,
        allColumns: false,
        createdBy: ownerId,
        columns: { create: [{ columnId: amount.id }] },
      },
    });
    const source = await prisma.source.findUniqueOrThrow({ where: { id } });

    sheet.tab(1).rows.push(["food", "300.5"]);
    const summary = await syncSheetsSource(id, ownerId);

    expect(summary).toEqual({
      synced_at: expect.any(String),
      tables: [{ id: before.id, name: "costs", row_count: 2, missing: false }],
    });
    const after = await tableNamed(id, "costs");
    expect(after.columns.map((c) => [c.id, c.name, c.type, c.missing])).toEqual(
      before.columns.map((c) => [
        c.id,
        c.name,
        c.id === amount.id ? "text" : c.type,
        false,
      ])
    );
    expect(after.row_count).toBe(2);
    expect(Date.parse(after.last_loaded_at!)).toBeGreaterThanOrEqual(
      Date.parse(before.last_loaded_at!)
    );
    expect(await storedRows(id, "costs")).toEqual([
      { item: "rent", amount: "1200" },
      { item: "food", amount: "300.5" },
    ]);
    expect(
      await prisma.grantColumn.findMany({ where: { grantId: grant.id } })
    ).toMatchObject([{ columnId: amount.id }]);
    const row = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(row.lastSyncError).toBeNull();
    expect(row.status).toBe("active");
    expect(row.lastSyncAttemptAt!.getTime()).toBeGreaterThan(
      source.lastSyncAttemptAt!.getTime() - 1
    );
    expect(row.lastRefreshedAt!.toISOString()).toBe(summary.synced_at);
    expect(row.lastSyncAttemptAt!.toISOString()).toBe(summary.synced_at);
  });

  it("a renamed and moved tab still syncs into its table", async () => {
    const { sheet, id } = await makeSource();
    const before = await tableNamed(id, "costs");
    sheet.tab(1).title = "Spend 2026";
    sheet.tab(1).rows.push(["food", "300"]);
    sheet.tabs.unshift({ sheetId: 9, title: "Other", rows: [["x"], ["1"]] });

    await syncSheetsSource(id, ownerId);

    const tables = await uploadTablesOf(id);
    expect(tables.map((t) => [t.id, t.name, t.row_count])).toEqual([
      [before.id, "costs", 2],
    ]);
  });

  it("a deleted tab marks its table missing", async () => {
    const { sheet, id } = await makeSource([
      costs(),
      { sheetId: 2, title: "Notes", rows: [["note"], ["hello"]] },
    ]);
    const notes = await tableNamed(id, "notes");
    sheet.tabs = sheet.tabs.filter((t) => t.sheetId !== 2);

    const summary = await syncSheetsSource(id, ownerId);

    expect(summary.tables).toEqual(
      expect.arrayContaining([
        { id: notes.id, name: "notes", row_count: 1, missing: true },
        expect.objectContaining({ name: "costs", missing: false }),
      ])
    );
    const after = await tableNamed(id, "notes");
    expect(after.missing).toBe(true);
    expect(after.columns.every((c) => c.missing)).toBe(true);
    expect(await storedTables(id)).toEqual(["costs"]);

    // A missing table is not read again.
    google.getSpreadsheet.mockClear();
    await syncSheetsSource(id, ownerId);
    expect(await storedTables(id)).toEqual(["costs"]);
  });

  it("a tab restored after deletion syncs into its old table, keeping its id and grants", async () => {
    const { sheet, id } = await makeSource([
      costs(),
      { sheetId: 2, title: "Notes", rows: [["note"], ["hello"]] },
    ]);
    const notes = await tableNamed(id, "notes");
    await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: granteeId,
        tableId: notes.id,
        allColumns: true,
        createdBy: ownerId,
      },
    });
    const restored = sheet.tab(2);
    sheet.tabs = sheet.tabs.filter((t) => t.sheetId !== 2);
    await syncSheetsSource(id, ownerId);
    expect((await tableNamed(id, "notes")).missing).toBe(true);

    // Undo in Sheets brings the tab back with its sheetId.
    sheet.tabs.push({ ...restored, rows: [["note"], ["hello"], ["again"]] });
    const summary = await syncSheetsSource(id, ownerId);

    expect(summary.tables).toContainEqual({
      id: notes.id,
      name: "notes",
      row_count: 2,
      missing: false,
    });
    const after = await tableNamed(id, "notes");
    expect(after.missing).toBe(false);
    expect(after.columns.map((c) => [c.id, c.missing])).toEqual(
      notes.columns.map((c) => [c.id, false])
    );
    expect(await storedTables(id)).toEqual(["costs", "notes"]);
    const { slug } = await prisma.source.findUniqueOrThrow({ where: { id } });
    const res = await postQuery(
      tokenFor({ userId: granteeId, permissions: [DATA_READ] }),
      {
        source: slug,
        from: "notes",
        select: ["note"],
        orderBy: [{ note: "desc" }],
      },
      app.url
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toEqual([["hello"], ["again"]]);
  });

  it("a table removed by the owner stays removed after sync", async () => {
    const { id } = await makeSource([
      costs(),
      { sheetId: 2, title: "Notes", rows: [["note"], ["hello"]] },
    ]);
    const notes = await tableNamed(id, "notes");
    await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: granteeId,
        tableId: notes.id,
        allColumns: true,
        createdBy: ownerId,
      },
    });
    await removeTable(owner, id, notes.id);

    const summary = await syncSheetsSource(id, ownerId);

    expect(summary.tables.map((t) => t.name)).toEqual(["costs"]);
    expect((await tableNamed(id, "notes")).missing).toBe(true);
    expect(await storedTables(id)).toEqual(["costs"]);
    const { slug } = await prisma.source.findUniqueOrThrow({ where: { id } });
    const res = await postQuery(
      tokenFor({ userId: granteeId, permissions: [DATA_READ] }),
      { source: slug, from: "notes", select: ["note"] },
      app.url
    );
    // Missing, as the grantee is told of any granted table that is gone.
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("missing_in_source");
  });

  it("a tab whose table the owner removed can be added again, under a new name", async () => {
    const { sheet, id } = await makeSource([
      costs(),
      { sheetId: 2, title: "Notes", rows: [["note"], ["hello"]] },
    ]);
    const notes = await tableNamed(id, "notes");
    await removeTable(owner, id, notes.id);

    const staged = await stageFakeSheet(ownerId, sheet);
    await addTables(owner, id, {
      staging_id: staged.stagingId,
      tables: [{ key: "sheet:2", name: "notes_again" }],
    });
    sheet.tab(2).rows.push(["again"]);
    await syncSheetsSource(id, ownerId);

    const again = await tableNamed(id, "notes_again");
    expect(again).toMatchObject({ missing: false, row_count: 2 });
    expect((await tableNamed(id, "notes")).missing).toBe(true);
    expect(await storedTables(id)).toEqual(["costs", "notes_again"]);
  });

  it("a sync refused as busy records no sync failure", async () => {
    const { sheet, id } = await makeSource();
    const before = await prisma.source.findUniqueOrThrow({ where: { id } });
    sheet.tab(1).rows.push(["food", "300"]);
    const timeout = LOAD_LOCKING.swapTimeoutMs;
    LOAD_LOCKING.swapTimeoutMs = 1;
    try {
      await expect(syncSheetsSource(id, ownerId)).rejects.toMatchObject({
        code: "upload_source_busy",
      });
    } finally {
      LOAD_LOCKING.swapTimeoutMs = timeout;
    }
    const row = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(row.lastSyncError).toBeNull();
    expect(row.lastSyncAttemptAt).toEqual(before.lastSyncAttemptAt);
  });

  it("a new header column is added; a removed one is marked missing", async () => {
    const { sheet, id } = await makeSource();
    const before = await tableNamed(id, "costs");
    sheet.tab(1).rows = [
      ["item", "paid"],
      ["rent", "true"],
    ];

    await syncSheetsSource(id, ownerId);

    const after = await tableNamed(id, "costs");
    const byName = new Map(after.columns.map((c) => [c.name, c]));
    expect(byName.get("item")).toMatchObject({
      id: before.columns[0]!.id,
      missing: false,
    });
    expect(byName.get("amount")).toMatchObject({
      id: before.columns[1]!.id,
      missing: true,
    });
    expect(byName.get("paid")).toMatchObject({
      type: "boolean",
      missing: false,
    });
    expect(await storedRows(id, "costs")).toEqual([
      { item: "rent", paid: true },
    ]);
  });

  it("a column renamed in Zeteo still matches its sheet header", async () => {
    const { sheet, id } = await makeSource();
    const before = await tableNamed(id, "costs");
    const amount = before.columns.find((c) => c.name === "amount")!;
    await changeColumn(owner, id, before.id, amount.id, { name: "cost" });
    sheet.tab(1).rows.push(["food", "300"]);

    await syncSheetsSource(id, ownerId);

    const after = await tableNamed(id, "costs");
    expect(after.columns.map((c) => [c.id, c.name, c.missing])).toEqual([
      [before.columns[0]!.id, "item", false],
      [amount.id, "cost", false],
    ]);
    expect(await storedRows(id, "costs")).toEqual([
      { item: "rent", cost: 1200 },
      { item: "food", cost: 300 },
    ]);
  });

  it("a value that no longer casts fails the sync, keeps the data and records cast_failed naming the column", async () => {
    const { sheet, id } = await makeSource();
    const before = await prisma.source.findUniqueOrThrow({ where: { id } });
    const table = await tableNamed(id, "costs");
    sheet.tab(1).rows.push(["food", "lots"]);

    await expect(syncSheetsSource(id, ownerId)).rejects.toMatchObject({
      code: "cast_failed",
    });

    expect(await storedRows(id, "costs")).toEqual([
      { item: "rent", amount: 1200 },
    ]);
    expect(await tableNamed(id, "costs")).toEqual(table);
    const row = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(row.lastSyncError).toEqual({
      code: "cast_failed",
      message: expect.stringMatching(/"amount".*"costs".*rows? 3/),
    });
    expect(row.lastSyncAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      before.lastSyncAttemptAt!.getTime()
    );
    expect(row.lastRefreshedAt).toEqual(before.lastRefreshedAt);
    expect(await storedTables(id)).toEqual(["costs"]);
  });

  it("stale after 24h of failures", async () => {
    const { sheet, id } = await makeSource();
    sheet.failWith = "GGL_0009";

    await expect(syncSheetsSource(id, ownerId)).rejects.toMatchObject({
      code: "sheet_not_accessible",
    });
    const fresh = await presentSourceById(id);
    expect(fresh.sync).toMatchObject({
      last_error: { code: "sheet_not_accessible" },
      stale: false,
    });

    await prisma.source.update({
      where: { id },
      data: { lastRefreshedAt: new Date(Date.now() - 25 * 3600_000) },
    });
    await expect(syncSheetsSource(id, ownerId)).rejects.toMatchObject({
      code: "sheet_not_accessible",
    });
    expect((await presentSourceById(id)).sync).toMatchObject({
      last_error: { code: "sheet_not_accessible" },
      stale: true,
    });

    // A good sync clears both.
    sheet.failWith = null;
    await syncSheetsSource(id, ownerId);
    expect((await presentSourceById(id)).sync).toMatchObject({
      last_error: null,
      stale: false,
    });
  });
});
