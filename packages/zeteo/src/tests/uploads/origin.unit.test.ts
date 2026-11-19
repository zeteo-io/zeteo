// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  isFileTable,
  isMergedTable,
  isSheetsTable,
  originOf,
} from "../../uploads/origin.js";

const sheets = {
  kind: "google-sheets",
  spreadsheetId: "1abcDEF",
  spreadsheetTitle: "Sales 2026",
  sheetId: 0,
  headerRow: 1,
};
const merged = {
  kind: "merged",
  definition: {
    labelColumnId: "0190a000-0000-7000-8000-000000000001",
    members: [
      { tableId: "0190a000-0000-7000-8000-000000000002", label: "VIVO" },
      { tableId: "0190a000-0000-7000-8000-000000000003", label: "ChomChom" },
    ],
    columns: [
      {
        columnId: "0190a000-0000-7000-8000-000000000004",
        type: "number",
        from: {
          "0190a000-0000-7000-8000-000000000002":
            "0190a000-0000-7000-8000-000000000005",
        },
      },
    ],
  },
};

describe("originOf", () => {
  it("originOf parses file, google-sheets and merged origins", () => {
    expect(originOf({ origin: { kind: "file", filename: "a.csv" } })).toEqual({
      kind: "file",
      filename: "a.csv",
    });
    expect(originOf({ origin: sheets })).toEqual(sheets);
    expect(
      originOf({ origin: { ...sheets, headerRow: null, removed: true } })
    ).toEqual({ ...sheets, headerRow: null, removed: true });
    expect(originOf({ origin: merged })).toEqual(merged);
  });

  it("originOf returns null for garbage", () => {
    expect(originOf({ origin: null })).toBeNull();
    expect(originOf({ origin: undefined })).toBeNull();
    expect(originOf({ origin: "file" })).toBeNull();
    expect(originOf({ origin: { kind: "sharepoint" } })).toBeNull();
    expect(originOf({ origin: { kind: "file" } })).toBeNull();
    expect(originOf({ origin: { ...sheets, sheetId: "0" } })).toBeNull();
  });
});

describe("isSheetsTable/isFileTable/isMergedTable", () => {
  it("decide by the table's origin", () => {
    const file = { origin: { kind: "file", filename: "a.csv" } };
    expect(isFileTable(file)).toBe(true);
    expect(isSheetsTable(file)).toBe(false);
    expect(isMergedTable(file)).toBe(false);
    expect(isSheetsTable({ origin: sheets })).toBe(true);
    expect(isFileTable({ origin: sheets })).toBe(false);
    expect(isMergedTable({ origin: merged })).toBe(true);
    expect(isSheetsTable({ origin: null })).toBe(false);
    expect(isFileTable({ origin: null })).toBe(false);
    expect(isMergedTable({ origin: null })).toBe(false);
  });
});
