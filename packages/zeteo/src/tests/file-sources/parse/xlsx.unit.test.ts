// @module-tag unit
// @module-tag platform

import { parseXlsx } from "../../../file-sources/parse/xlsx.js";
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";

const limits = { maxRows: 100, maxColumns: 10 };

async function build(fill: (wb: ExcelJS.Workbook) => void): Promise<Readable> {
  const wb = new ExcelJS.Workbook();
  fill(wb);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return Readable.from([buf]);
}

describe("parseXlsx", () => {
  it("xlsx lists sheets and named tables", async () => {
    const stream = await build((wb) => {
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
    const sheets = await parseXlsx(stream, limits);
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
    const stream = await build((wb) => {
      const ws = wb.addWorksheet("F");
      ws.getCell("A1").value = "n";
      ws.getCell("A2").value = 2;
      ws.getCell("A3").value = { formula: "A2*21", result: 42 };
    });
    const [sheet] = await parseXlsx(stream, limits);
    expect(sheet?.rows).toEqual([["n"], ["2"], ["42"]]);
  });

  it("xlsx merged cell is its top-left value", async () => {
    const stream = await build((wb) => {
      const ws = wb.addWorksheet("M");
      ws.addRow(["h1", "h2"]);
      ws.addRow(["merged", "z"]);
      ws.addRow(["", "w"]);
      ws.mergeCells("A2:A3");
    });
    const [sheet] = await parseXlsx(stream, limits);
    expect(sheet?.rows).toEqual([
      ["h1", "h2"],
      ["merged", "z"],
      ["merged", "w"],
    ]);
  });

  it("renders dates as ISO 8601, booleans as text, trims empty edges", async () => {
    const stream = await build((wb) => {
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
    const [sheet] = await parseXlsx(stream, limits);
    expect(sheet?.rows).toEqual([
      ["d", "t", "b"],
      ["2024-01-05", "2024-01-05T10:30:00.000Z", "true"],
    ]);
  });

  it("errors past the row and column limits", async () => {
    const stream = await build((wb) => {
      wb.addWorksheet("W").addRows([
        ["a", "b", "c"],
        [1, 2, 3],
        [4, 5, 6],
      ]);
    });
    await expect(
      parseXlsx(stream, { maxRows: 1, maxColumns: 10 })
    ).rejects.toMatchObject({
      code: "too_many_rows",
    });
    const stream2 = await build((wb) => {
      wb.addWorksheet("W").addRows([["a", "b", "c"]]);
    });
    await expect(
      parseXlsx(stream2, { maxRows: 10, maxColumns: 2 })
    ).rejects.toMatchObject({
      code: "too_many_columns",
    });
  });
});
