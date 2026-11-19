// @module-tag int
// @module-tag platform
import { dropStagingTable } from "../../uploads/storage.js";
import { afterEach, describe, expect, it } from "vitest";
import { stageTable } from "../../uploads/staging.js";

const created: string[] = [];

afterEach(async () => {
  for (const table of created.splice(0)) await dropStagingTable(table);
});

describe("stageTable", () => {
  const rows = [
    ["a", "b", ""],
    ["1", "2", ""],
  ];

  it("keeps an xlsx worksheet's trailing column of empty strings", async () => {
    const result = await stageTable(
      rows,
      { key: "sheet:Data", fallbackName: "Data", kind: "sheet" },
      new Set(),
      created
    );
    expect(result!.staged.columnCount).toBe(3);
    expect(result!.preview.columns).toHaveLength(3);
  });

  it("trims it when asked to, as for a Google Sheets tab", async () => {
    const result = await stageTable(
      rows,
      {
        key: "sheet:1",
        fallbackName: "Data",
        kind: "sheet",
        trimUnusedColumns: true,
      },
      new Set(),
      created
    );
    expect(result!.staged.columnCount).toBe(2);
  });
});
