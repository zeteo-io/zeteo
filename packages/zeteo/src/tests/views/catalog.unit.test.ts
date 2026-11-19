// @module-tag unit
// @module-tag platform
import { originView } from "../../views/catalog.js";
import { describe, expect, it } from "vitest";

describe("originView", () => {
  it("gives a Sheets origin in snake_case with its link", () => {
    expect(
      originView({
        origin: {
          kind: "google-sheets",
          spreadsheetId: "abc",
          spreadsheetTitle: "Budget",
          sheetId: 7,
          headerRow: 0,
        },
      })
    ).toEqual({
      kind: "google-sheets",
      spreadsheet_id: "abc",
      spreadsheet_title: "Budget",
      url: "https://docs.google.com/spreadsheets/d/abc/edit#gid=7",
      tab_id: 7,
    });
  });

  it("gives a Sheets origin's tab title when it is kept", () => {
    expect(
      originView({
        origin: {
          kind: "google-sheets",
          spreadsheetId: "abc",
          spreadsheetTitle: "Budget",
          sheetId: 7,
          headerRow: 0,
          tabTitle: "FBA Inventory Master",
        },
      })
    ).toMatchObject({ tab_id: 7, tab_title: "FBA Inventory Master" });
  });

  it("gives a file's origin as it is and a merged one as its member count", () => {
    expect(originView({ origin: { kind: "file", filename: "a.csv" } })).toEqual(
      { kind: "file", filename: "a.csv" }
    );
    expect(
      originView({
        origin: {
          kind: "merged",
          definition: {
            labelColumnId: "l",
            members: [
              { tableId: "a", label: "A" },
              { tableId: "b", label: "B" },
            ],
            columns: [],
          },
        },
      })
    ).toEqual({ kind: "merged", members: 2 });
    expect(originView({ origin: null })).toBeNull();
  });

  it("gives a file's worksheet as tab_title, only when it is known", () => {
    expect(
      originView({ origin: { kind: "file", filename: "a.xlsx", sheet: "S" } })
    ).toEqual({ kind: "file", filename: "a.xlsx", tab_title: "S" });
    expect(originView({ origin: { kind: "file", filename: "a.csv" } })).toEqual(
      { kind: "file", filename: "a.csv" }
    );
  });
});
