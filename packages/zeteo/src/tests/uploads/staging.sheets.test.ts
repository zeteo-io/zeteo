// @module-tag int
// @module-tag platform
import { assertSheetUnclaimed, stageSheets } from "../../uploads/staging.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeUploadSourcesOf } from "../support/uploads.js";
import { listStagingTables } from "../../uploads/storage.js";
import type { Row } from "../../uploads/parse/types.js";
import { SheetInUseError } from "../../utils/errors.js";
import { uniqueSlug } from "../support/sources.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import env from "../../env.js";

const owner = randomUUID();

const tab = (sheetId: number, name: string, rows: Row[]) => ({
  sheetId,
  name,
  kind: "sheet" as const,
  rows,
});

const sheet = (id = `sheet-${randomUUID()}`) => ({
  id,
  title: "Budget",
  tabs: [
    tab(0, "Costs", [
      ["item", "amount", "paid"],
      ["rent", "1200", "true"],
      ["food", "300.5", "false"],
    ]),
    tab(77, "Notes", [["note"], ["hello"]]),
  ],
});

afterEach(async () => {
  await removeUploadSourcesOf([owner]);
});
afterAll(async () => {
  await prisma.source.deleteMany({ where: { createdBy: owner } });
});

describe("stageSheets", () => {
  it("stages each tab with its sheetId and a preview like an upload", async () => {
    const result = await stageSheets({ ownerId: owner, spreadsheet: sheet() });
    expect(result.tables.map((t) => [t.key, t.name, t.kind])).toEqual([
      ["sheet:0", "costs", "sheet"],
      ["sheet:77", "notes", "sheet"],
    ]);
    const costs = result.tables[0]!;
    expect(costs.header_row).toBe(0);
    expect(costs.row_count).toBe(2);
    expect(costs.columns.map((c) => [c.name, c.type, c.samples])).toEqual([
      ["item", "text", ["rent", "food"]],
      ["amount", "number", ["1200", "300.5"]],
      ["paid", "boolean", ["true", "false"]],
    ]);
    const row = await prisma.uploadStaging.findUniqueOrThrow({
      where: { id: result.stagingId },
    });
    expect(
      (row.tables as { key: string; locator?: unknown }[]).map((t) => [
        t.key,
        t.locator,
      ])
    ).toEqual([
      ["sheet:0", { sheetId: 0 }],
      ["sheet:77", { sheetId: 77 }],
    ]);
  });

  it("suggests the header row under a banner", async () => {
    const result = await stageSheets({
      ownerId: owner,
      spreadsheet: {
        id: `sheet-${randomUUID()}`,
        title: "FBA",
        tabs: [
          tab(0, "Stock", [
            [
              "Updated 2026-11-18 14:31:11",
              null,
              null,
              null,
              "General Quantity",
            ],
            ["SKU", "ASIN", "Condition", "Total Quantity", "Fulfillable"],
            ["A-1", "B000", "New", "12", "10"],
            ["A-2", "B001", "Used", "3", "3"],
          ]),
        ],
      },
    });
    const stock = result.tables[0]!;
    expect(stock.header_row).toBe(1);
    expect(stock.columns.map((c) => [c.name, c.type])).toEqual([
      ["sku", "text"],
      ["asin", "text"],
      ["condition", "text"],
      ["total_quantity", "number"],
      ["fulfillable", "number"],
    ]);
  });

  it("records kind google-sheets and the vendor file id", async () => {
    const spreadsheet = sheet();
    const result = await stageSheets({ ownerId: owner, spreadsheet });
    const row = await prisma.uploadStaging.findUniqueOrThrow({
      where: { id: result.stagingId },
    });
    expect(row).toMatchObject({
      kind: "google-sheets",
      vendorFileId: spreadsheet.id,
      ownerId: owner,
    });
  });

  it("counts against UPLOAD_MAX_STAGINGS like a file", async () => {
    const max = env.UPLOAD_MAX_STAGINGS;
    env.UPLOAD_MAX_STAGINGS = 1;
    try {
      await stageSheets({ ownerId: owner, spreadsheet: sheet() });
      const before = new Set(await listStagingTables());
      await expect(
        stageSheets({ ownerId: owner, spreadsheet: sheet() })
      ).rejects.toMatchObject({ code: "too_many_stagings" });
      // The refused staging's tables were made before recordStaging refused it.
      expect((await listStagingTables()).filter((t) => !before.has(t))).toEqual(
        []
      );
    } finally {
      env.UPLOAD_MAX_STAGINGS = max;
    }
  });

  it("gives two tabs whose titles normalise alike distinct table names", async () => {
    const result = await stageSheets({
      ownerId: owner,
      spreadsheet: {
        id: `sheet-${randomUUID()}`,
        title: "T",
        tabs: [
          tab(1, "Costs", [["a"], ["1"]]),
          tab(2, "costs", [["a"], ["2"]]),
        ],
      },
    });
    expect(result.tables.map((t) => t.name)).toEqual(["costs", "costs_2"]);
  });

  it("stages a 26-column grid with data in A-D as 4 columns, and an all-empty tab as nothing", async () => {
    const wide = (cells: (string | null)[]): Row => [
      ...cells,
      ...Array(26 - cells.length).fill(null),
    ];
    const result = await stageSheets({
      ownerId: owner,
      spreadsheet: {
        id: `sheet-${randomUUID()}`,
        title: "T",
        tabs: [
          tab(1, "Wide", [
            wide(["a", "b", "c", "d"]),
            wide(["1", "2", "3", "4"]),
            wide([]),
            wide(["5", "6", null, "8"]),
          ]),
          tab(2, "Blank", [wide([]), wide([])]),
        ],
      },
    });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.columns.map((c) => c.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    const row = await prisma.uploadStaging.findUniqueOrThrow({
      where: { id: result.stagingId },
    });
    expect(row.tables).toMatchObject([{ key: "sheet:1", columnCount: 4 }]);
  });

  it("drops its staging tables when a tab fails", async () => {
    const before = (await listStagingTables()).sort();
    const failing = {
      sheetId: 5,
      name: "Bad",
      kind: "sheet" as const,
      rows: (async function* () {
        yield ["a"];
        throw new Error("read failed");
      })(),
    };
    const spreadsheet = { ...sheet(), tabs: [...sheet().tabs, failing] };
    await expect(stageSheets({ ownerId: owner, spreadsheet })).rejects.toThrow(
      "read failed"
    );
    expect((await listStagingTables()).sort()).toEqual(before);
    expect(
      await prisma.uploadStaging.count({ where: { ownerId: owner } })
    ).toBe(0);
  });

  it("answers EmptyFileError for a spreadsheet with no rows", async () => {
    await expect(
      stageSheets({
        ownerId: owner,
        spreadsheet: { id: "x", title: "T", tabs: [tab(1, "Empty", [])] },
      })
    ).rejects.toMatchObject({ code: "empty_file" });
  });
});

describe("assertSheetUnclaimed", () => {
  it("throws sheet_in_use for an unarchived google_sheets source and not for an archived one", async () => {
    const spreadsheetId = `sheet-${randomUUID()}`;
    const source = await prisma.source.create({
      data: {
        slug: uniqueSlug("sheet"),
        name: "Sheet source",
        type: "google_sheets",
        ownerId: owner,
        sealedSettings: {},
        schemas: [],
        createdBy: owner,
        vendorFileId: spreadsheetId,
      },
    });
    const err = await assertSheetUnclaimed(spreadsheetId).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SheetInUseError);
    expect(err).toMatchObject({
      statusCode: 409,
      code: "sheet_in_use",
      message:
        "This spreadsheet is already a Zeteo source. Ask an admin if it should be yours.",
    });
    await assertSheetUnclaimed(`other-${randomUUID()}`);
    await prisma.source.update({
      where: { id: source.id },
      data: { archivedAt: new Date() },
    });
    await assertSheetUnclaimed(spreadsheetId);
  });
});
