// @module-tag int
// @module-tag platform
import { removeUploadSourcesOf, uploadTablesOf } from "../support/uploads.js";
import { dropStoredTable, schemaFor } from "../../uploads/storage.js";
import type { Caller } from "../../middleware/auth.js";
import { startV1Routes } from "../support/v1App.js";
import { syncSource } from "../../uploads/sync.js";
import { inSwap } from "../../uploads/loading.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  FakeSpreadsheet,
  serveSheets,
  stageFakeSheet,
  type FakeTab,
} from "../support/googleSheets.js";
import {
  addTables,
  changeColumn,
  createUploadSource,
} from "../../uploads/service.js";
import {
  columnUnion,
  mergedColumns,
  mergedDetail,
  saveMergedTable,
} from "../../uploads/merged.js";
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
const owner: Caller = {
  userId: ownerId,
  organizationId: null,
  permissions: [DATA_READ, UPLOADS_WRITE],
  isServiceAccount: false,
};

const sheets = new Map<string, FakeSpreadsheet>();
// The services read through the tereo client, which must be up.
let app: Awaited<ReturnType<typeof startV1Routes>>;

beforeAll(async () => {
  app = await startV1Routes();
});
beforeEach(() => {
  serveSheets(google, sheets);
});
afterEach(async () => {
  sheets.clear();
  await removeUploadSourcesOf([ownerId]);
});
afterAll(async () => {
  await prisma.source.deleteMany({ where: { createdBy: ownerId } });
  await app.close();
});

const PREFIX = "FBA Inventory - Updates Every Hour - Amazon Inventory - ";
const BRANDS = [
  "Watermelon Ball",
  "Rak Pro Tools",
  "ChomChom",
  "Cooler Shock",
  "VIVO",
];

const fbaTab = (rows: (string | null)[][]): FakeTab => ({
  sheetId: 7,
  title: "FBA Inventory Master",
  rows,
});

/**
 * An upload source with one table per spreadsheet (each of one tab), named
 * `t0`, `t1`... in order: the first creates the source, the others are added.
 */
const makeSource = async (tabs: FakeTab[], titles?: string[]) => {
  let id = "";
  const made: FakeSpreadsheet[] = [];
  for (const [i, tab] of tabs.entries()) {
    const sheet = new FakeSpreadsheet(
      `sheet-${randomUUID()}`,
      [tab],
      titles?.[i] ?? `Book ${i}`
    );
    sheets.set(sheet.id, sheet);
    made.push(sheet);
    const staged = await stageFakeSheet(ownerId, sheet);
    const table = { key: `sheet:${tab.sheetId}`, name: `t${i}` };
    if (i === 0) {
      id = (
        await createUploadSource(owner, {
          type: "upload",
          staging_id: staged.stagingId,
          name: "Inventory",
          tables: [table],
        })
      ).id;
    } else {
      await addTables(owner, id, {
        staging_id: staged.stagingId,
        tables: [table],
      });
    }
  }
  const tables = await uploadTablesOf(id);
  const byName = (name: string) => tables.find((t) => t.name === name)!;
  return { id, sheets: made, tables: tabs.map((_, i) => byName(`t${i}`)) };
};

/** The merged view's rows, as JSON, in `order`. */
const viewRows = async (sourceId: string, view: string, order: string) =>
  (
    await prisma.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(
      `SELECT to_jsonb(v) AS r FROM "${schemaFor(sourceId)}"."${view}" v ORDER BY ${order}`
    )
  ).map((x) => x.r);

const columnsBody = (names: string[], include = names) =>
  names.map((n) => ({ name: n, from_name: n, include: include.includes(n) }));

const merge = (
  sourceId: string,
  members: { id: string }[],
  labels: string[],
  columns: string[],
  include = columns
) =>
  saveMergedTable(owner, sourceId, {
    name: "all_inventory",
    label_column: "brand",
    members: members.map((m, i) => ({ table_id: m.id, label: labels[i]! })),
    columns: columnsBody(columns, include),
  });

/** The merged table's detail; it must be one. */
const detailOf = async (sourceId: string, tableId: string) =>
  (await mergedDetail(sourceId, tableId))!;

const mergedTable = async (sourceId: string) =>
  (await uploadTablesOf(sourceId)).find((t) => t.name === "all_inventory")!;

describe("merged tables", () => {
  it("five FBA-shaped members (four with vivo_sku, one without) merge with vivo_sku NULL for the fifth and a brand column", async () => {
    const tabs = BRANDS.map((_, i) =>
      i === 4
        ? fbaTab([
            ["sku", "total_quantity"],
            [`s${i}`, `${i}`],
          ])
        : fbaTab([
            ["sku", "total_quantity", "vivo_sku"],
            [`s${i}`, `${i}`, `v${i}`],
          ])
    );
    const { id, tables } = await makeSource(
      tabs,
      BRANDS.map((b) => PREFIX + b)
    );

    const editor = await mergedColumns(
      id,
      tables.map((t) => t.id)
    );
    expect(Object.values(editor.labels)).toEqual(BRANDS);
    expect(editor.columns).toEqual([
      {
        name: "sku",
        type: "text",
        types: ["text"],
        members: tables.map((t) => t.id),
      },
      {
        name: "total_quantity",
        type: "number",
        types: ["number"],
        members: tables.map((t) => t.id),
      },
      {
        name: "vivo_sku",
        type: "text",
        types: ["text"],
        members: tables.slice(0, 4).map((t) => t.id),
      },
    ]);
    const union = await columnUnion(
      id,
      tables.map((t) => t.id)
    );
    expect(union.find((c) => c.name === "vivo_sku")!.inMembers).toHaveLength(4);

    const view = await merge(id, tables, BRANDS, [
      "sku",
      "total_quantity",
      "vivo_sku",
    ]);
    expect(view).toMatchObject({
      name: "all_inventory",
      kind: "view",
      row_count: 5,
      origin: { kind: "merged", members: 5 },
    });

    const rows = await viewRows(id, "all_inventory", "sku");
    expect(rows).toEqual(
      BRANDS.map((brand, i) => ({
        brand,
        sku: `s${i}`,
        total_quantity: i,
        vivo_sku: i === 4 ? null : `v${i}`,
      }))
    );
    const merged = await mergedTable(id);
    expect(merged.columns.map((c) => [c.name, c.type, c.missing])).toEqual([
      ["brand", "text", false],
      ["sku", "text", false],
      ["total_quantity", "number", false],
      ["vivo_sku", "text", false],
    ]);
    // The owner holds it like any table of theirs.
    const grant = await prisma.grant.findFirst({
      where: { tableId: merged.id, principalId: ownerId },
    });
    expect(grant).toMatchObject({ allColumns: true, ownerGrant: true });
  });

  it("a member re-syncs and the merged table shows its new rows", async () => {
    const {
      id,
      tables,
      sheets: made,
    } = await makeSource([fbaTab([["sku"], ["a"]]), fbaTab([["sku"], ["b"]])]);
    await merge(id, tables, ["A", "B"], ["sku"]);
    made[1]!.tab(7).rows.push(["c"]);

    await syncSource(id, ownerId);

    expect(await viewRows(id, "all_inventory", "sku")).toEqual([
      { brand: "A", sku: "a" },
      { brand: "B", sku: "b" },
      { brand: "B", sku: "c" },
    ]);
    expect((await mergedTable(id)).row_count).toBe(3);
  });

  it("number vs text members give a text column holding both", async () => {
    const { id, tables } = await makeSource([
      fbaTab([["qty"], ["12"]]),
      fbaTab([["qty"], ["many"]]),
    ]);
    const editor = await mergedColumns(
      id,
      tables.map((t) => t.id)
    );
    expect(editor.columns).toEqual([
      {
        name: "qty",
        type: "text",
        types: ["number", "text"],
        members: tables.map((t) => t.id),
      },
    ]);
    await merge(id, tables, ["A", "B"], ["qty"]);
    expect(await viewRows(id, "all_inventory", "brand")).toEqual([
      { brand: "A", qty: "12" },
      { brand: "B", qty: "many" },
    ]);
    const merged = await mergedTable(id);
    expect(merged.columns.find((c) => c.name === "qty")!.type).toBe("text");
  });

  it("a member tab deleted in Sheets drops its rows with a warning, and restoring it rejoins", async () => {
    const {
      id,
      tables,
      sheets: made,
    } = await makeSource([
      fbaTab([["sku"], ["a"]]),
      fbaTab([["sku"], ["b"]]),
      fbaTab([["sku"], ["c"]]),
    ]);
    await merge(id, tables, ["A", "B", "C"], ["sku"]);
    const tab = made[1]!.tab(7);
    made[1]!.tabs = [];

    await syncSource(id, ownerId);

    expect(await viewRows(id, "all_inventory", "sku")).toEqual([
      { brand: "A", sku: "a" },
      { brand: "C", sku: "c" },
    ]);
    const merged = await mergedTable(id);
    expect(merged.row_count).toBe(2);
    const detail = await detailOf(id, merged.id);
    expect(detail.members.map((m) => [m.label, m.missing])).toEqual([
      ["A", false],
      ["B", true],
      ["C", false],
    ]);

    made[1]!.tabs = [tab];
    await syncSource(id, ownerId);

    expect(await viewRows(id, "all_inventory", "sku")).toEqual([
      { brand: "A", sku: "a" },
      { brand: "B", sku: "b" },
      { brand: "C", sku: "c" },
    ]);
    expect(
      (await detailOf(id, merged.id)).members.every((m) => !m.missing)
    ).toBe(true);
  });

  it("a member's stored table dropped through inSwap with no loads rebuilds the view without it", async () => {
    const { id, tables } = await makeSource([
      fbaTab([["sku"], ["a"]]),
      fbaTab([["sku"], ["b"]]),
    ]);
    await merge(id, tables, ["A", "B"], ["sku"]);

    // As a sync's "tab gone" path does it, in its own swap with nothing loaded.
    await inSwap(id, [], [tables[1]!.id], async (tx) => {
      const now = new Date();
      await dropStoredTable(tx, id, "t1");
      await tx.sourceTable.update({
        where: { id: tables[1]!.id },
        data: { missingSince: now },
      });
      await tx.sourceColumn.updateMany({
        where: { tableId: tables[1]!.id },
        data: { missingSince: now },
      });
    });

    expect(await viewRows(id, "all_inventory", "sku")).toEqual([
      { brand: "A", sku: "a" },
    ]);
    expect((await mergedTable(id)).row_count).toBe(1);
  });

  it("retyping a member column to text under a number merged column gives NULL for that member and a warning", async () => {
    const { id, tables } = await makeSource([
      fbaTab([["qty"], ["1"]]),
      fbaTab([["qty"], ["2"]]),
    ]);
    await merge(id, tables, ["A", "B"], ["qty"]);
    const qty = tables[1]!.columns.find((c) => c.name === "qty")!;

    await changeColumn(owner, id, tables[1]!.id, qty.id, { type: "text" });

    expect(await viewRows(id, "all_inventory", "brand")).toEqual([
      { brand: "A", qty: 1 },
      { brand: "B", qty: null },
    ]);
    const merged = await mergedTable(id);
    const mergedQty = merged.columns.find((c) => c.name === "qty")!;
    expect(mergedQty).toMatchObject({ type: "number", missing: false });
    const detail = await detailOf(id, merged.id);
    expect(detail.warnings).toEqual([
      { column_id: mergedQty.id, table_id: tables[1]!.id },
    ]);
    expect(detail.columns.find((c) => c.name === "qty")!.members).toEqual([
      tables[0]!.id,
      tables[1]!.id,
    ]);
  });

  it("a selected column that vanishes from all members goes missing and comes back with its id", async () => {
    const {
      id,
      tables,
      sheets: made,
    } = await makeSource([
      fbaTab([
        ["sku", "note"],
        ["a", "x"],
      ]),
      fbaTab([
        ["sku", "note"],
        ["b", "y"],
      ]),
    ]);
    await merge(id, tables, ["A", "B"], ["sku", "note"]);
    const before = (await mergedTable(id)).columns.find(
      (c) => c.name === "note"
    )!;
    for (const s of made) s.tab(7).rows = s.tab(7).rows.map((r) => [r[0]!]);

    await syncSource(id, ownerId);

    let note = (await mergedTable(id)).columns.find((c) => c.name === "note")!;
    expect(note).toMatchObject({ id: before.id, missing: true });
    expect(await viewRows(id, "all_inventory", "sku")).toEqual([
      { brand: "A", sku: "a", note: null },
      { brand: "B", sku: "b", note: null },
    ]);
    // Saving the merged table with the column still ticked keeps its time.
    const since = async () =>
      (
        await prisma.sourceColumn.findUniqueOrThrow({
          where: { id: before.id },
        })
      ).missingSince;
    const wentMissing = await since();
    await saveMergedTable(
      owner,
      id,
      {
        name: "all_inventory",
        label_column: "brand",
        members: tables.map((t, i) => ({ table_id: t.id, label: "AB"[i]! })),
        columns: [
          { name: "sku", from_name: "sku", include: true },
          { name: "note", from_name: "note", include: true },
        ],
      },
      (await mergedTable(id)).id
    );
    expect(await since()).toEqual(wentMissing);

    made[0]!.tab(7).rows = [
      ["sku", "note"],
      ["a", "back"],
    ];
    await syncSource(id, ownerId);

    note = (await mergedTable(id)).columns.find((c) => c.name === "note")!;
    expect(note).toMatchObject({ id: before.id, missing: false });
    expect(await viewRows(id, "all_inventory", "sku")).toEqual([
      { brand: "A", sku: "a", note: "back" },
      { brand: "B", sku: "b", note: null },
    ]);
  });

  it(`a label "O'Brien" and "x'); drop table t; --" round-trip exactly`, async () => {
    const { id, tables } = await makeSource([
      fbaTab([["sku"], ["a"]]),
      fbaTab([["sku"], ["b"]]),
      fbaTab([["sku"], ["c"]]),
    ]);
    const labels = ["O'Brien", "x'); drop table t; --", "back\\'slash"];
    await merge(id, tables, labels, ["sku"]);
    expect(
      (await viewRows(id, "all_inventory", "sku")).map((r) => r.brand)
    ).toEqual(labels);
    expect((await uploadTablesOf(id)).filter((t) => !t.missing)).toHaveLength(
      4
    );
    const merged = await mergedTable(id);
    expect((await detailOf(id, merged.id)).members.map((m) => m.label)).toEqual(
      labels
    );
  });

  it("editing keeps the ids of kept columns, marks a deselected one missing and renames the view", async () => {
    const { id, tables } = await makeSource([
      fbaTab([
        ["sku", "qty"],
        ["a", "1"],
      ]),
      fbaTab([
        ["sku", "qty"],
        ["b", "2"],
      ]),
    ]);
    const created = await merge(id, tables, ["A", "B"], ["sku", "qty"]);
    const before = await mergedTable(id);

    const edited = await saveMergedTable(
      owner,
      id,
      {
        name: "stock",
        label_column: "store",
        members: [
          { table_id: tables[0]!.id, label: "First" },
          { table_id: tables[1]!.id, label: "Second" },
        ],
        columns: [
          { name: "item", from_name: "sku", include: true },
          { name: "qty", from_name: "qty", include: false },
        ],
      },
      created.id
    );

    expect(edited).toMatchObject({ id: created.id, name: "stock" });
    const after = (await uploadTablesOf(id)).find((t) => t.name === "stock")!;
    const idOf = (t: typeof before, name: string) =>
      t.columns.find((c) => c.name === name)?.id;
    expect(idOf(after, "store")).toBe(idOf(before, "brand"));
    expect(idOf(after, "item")).toBe(idOf(before, "sku"));
    expect(after.columns.find((c) => c.name === "qty")).toMatchObject({
      id: idOf(before, "qty"),
      missing: true,
    });
    expect(await viewRows(id, "stock", "item")).toEqual([
      { store: "First", item: "a" },
      { store: "Second", item: "b" },
    ]);
    const views = await prisma.$queryRaw<{ viewname: string }[]>`
      SELECT viewname FROM pg_views WHERE schemaname = ${schemaFor(id)}`;
    expect(views.map((v) => v.viewname)).toEqual(["stock"]);
  });

  it("refuses a merged table as a member, a single member and duplicate labels", async () => {
    const { id, tables } = await makeSource([
      fbaTab([["sku"], ["a"]]),
      fbaTab([["sku"], ["b"]]),
    ]);
    await expect(
      merge(id, tables.slice(0, 1), ["A"], ["sku"])
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      merge(id, tables, ["A", " A "], ["sku"])
    ).rejects.toMatchObject({ code: "invalid_request" });
    const view = await merge(id, tables, ["A", "B"], ["sku"]);
    await expect(
      saveMergedTable(owner, id, {
        name: "again",
        label_column: "brand",
        members: [
          { table_id: view.id, label: "M" },
          { table_id: tables[0]!.id, label: "A" },
        ],
        columns: columnsBody(["sku"]),
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
