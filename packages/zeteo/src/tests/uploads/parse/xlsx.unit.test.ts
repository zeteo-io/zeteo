// @module-tag unit
// @module-tag platform

import { parseXlsx } from "../../../uploads/parse/xlsx.js";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

const limits = { maxRows: 100, maxColumns: 10 };

async function build(fill: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  fill(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseXlsx", () => {
  it("xlsx lists sheets and named tables", async () => {
    const bytes = await build((wb) => {
      const ws = wb.addWorksheet("Sales");
      ws.addRows([
        ["x", "y"],
        [1, 2],
      ]);
      ws.addTable({
        name: "Orders",
        ref: "D2",
        columns: [{ name: "id" }, { name: "total" }],
        rows: [
          [1, 10],
          [2, 20],
        ],
      });
      wb.addWorksheet("Other").addRows([["k"], ["v"]]);
    });
    const sheets = await parseXlsx(bytes, limits);
    expect(sheets.map((s) => [s.name, s.kind])).toEqual([
      ["Sales", "sheet"],
      ["Orders", "table"],
      ["Other", "sheet"],
    ]);
    const orders = sheets.find((s) => s.name === "Orders");
    expect(orders?.rows).toEqual([
      ["id", "total"],
      ["1", "10"],
      ["2", "20"],
    ]);
  });

  it("xlsx reads a formula's value", async () => {
    const bytes = await build((wb) => {
      const ws = wb.addWorksheet("F");
      ws.getCell("A1").value = "n";
      ws.getCell("A2").value = 2;
      ws.getCell("A3").value = { formula: "A2*21", result: 42 };
    });
    const [sheet] = await parseXlsx(bytes, limits);
    expect(sheet?.rows).toEqual([["n"], ["2"], ["42"]]);
  });

  it("xlsx merged cell is its top-left value", async () => {
    const bytes = await build((wb) => {
      const ws = wb.addWorksheet("M");
      ws.addRow(["h1", "h2"]);
      ws.addRow(["merged", "z"]);
      ws.addRow(["", "w"]);
      ws.mergeCells("A2:A3");
    });
    const [sheet] = await parseXlsx(bytes, limits);
    expect(sheet?.rows).toEqual([
      ["h1", "h2"],
      ["merged", "z"],
      ["merged", "w"],
    ]);
  });

  it("renders dates as ISO 8601, booleans as text, trims empty edges", async () => {
    const bytes = await build((wb) => {
      const ws = wb.addWorksheet("D");
      ws.addRow(["d", "t", "b"]);
      ws.addRow([
        new Date(Date.UTC(2024, 0, 5)),
        new Date(Date.UTC(2024, 0, 5, 10, 30)),
        true,
      ]);
      ws.getCell("E1").value = null;
      ws.getCell("A6").value = null;
    });
    const [sheet] = await parseXlsx(bytes, limits);
    expect(sheet?.rows).toEqual([
      ["d", "t", "b"],
      ["2024-01-05", "2024-01-05T10:30:00.000Z", "true"],
    ]);
  });

  it("errors past the row and column limits", async () => {
    const bytes = await build((wb) => {
      wb.addWorksheet("W").addRows([
        ["a", "b", "c"],
        [1, 2, 3],
        [4, 5, 6],
      ]);
    });
    await expect(
      parseXlsx(bytes, { maxRows: 1, maxColumns: 10 })
    ).rejects.toMatchObject({
      code: "too_many_rows",
    });
    const bytes2 = await build((wb) => {
      wb.addWorksheet("W").addRows([["a", "b", "c"]]);
    });
    await expect(
      parseXlsx(bytes2, { maxRows: 10, maxColumns: 2 })
    ).rejects.toMatchObject({
      code: "too_many_columns",
    });
  });

  it("fails on a far-out value without walking the sheet", async () => {
    const bytes = await build((wb) => {
      const ws = wb.addWorksheet("Big");
      ws.addRow(["a"]);
      ws.getCell("A1048576").value = "late";
      ws.getCell("XFD1").value = "wide";
    });
    const started = Date.now();
    await expect(parseXlsx(bytes, limits)).rejects.toMatchObject({
      code: expect.stringMatching(/^too_many_(rows|columns)$/),
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports the row limit and the column limit apart on sparse sheets", async () => {
    const rowy = await build((wb) => {
      wb.addWorksheet("R").getCell("A500000").value = "x";
    });
    await expect(parseXlsx(rowy, limits)).rejects.toMatchObject({
      code: "too_many_rows",
    });
    const widey = await build((wb) => {
      wb.addWorksheet("C").getCell("XFD1").value = "x";
    });
    await expect(parseXlsx(widey, limits)).rejects.toMatchObject({
      code: "too_many_columns",
    });
  });

  it("keeps blank rows and columns inside the data", async () => {
    const bytes = await build((wb) => {
      const ws = wb.addWorksheet("G");
      ws.getCell("A1").value = "a";
      ws.getCell("C1").value = "c";
      ws.getCell("A3").value = "z";
    });
    const [sheet] = await parseXlsx(bytes, limits);
    expect(sheet?.rows).toEqual([
      ["a", null, "c"],
      [null, null, null],
      ["z", null, null],
    ]);
  });
});
