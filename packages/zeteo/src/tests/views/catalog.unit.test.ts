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
});
