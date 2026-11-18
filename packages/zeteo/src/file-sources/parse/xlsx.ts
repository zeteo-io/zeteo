import type { ParseLimits, ParsedSheet, Row } from "./types.js";
import { FileParseError } from "./types.js";
import type { Readable } from "node:stream";
import ExcelJS from "exceljs";

function isoOf(date: Date): string {
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

function render(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  let text: string | null;
  if (typeof value === "string") text = value;
  else if (typeof value === "number") text = String(value);
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (value instanceof Date) text = isoOf(value);
  else if ("result" in value) {
    return render(value.result as ExcelJS.CellValue);
  } else if ("richText" in value) {
    text = value.richText.map((r) => r.text).join("");
  } else if ("text" in value) {
    text = typeof value.text === "string" ? value.text : render(value.text);
  } else if ("error" in value) text = null;
  else text = null;
  return text === null || text === "" ? null : text;
}

function tooManyRows(limits: ParseLimits): FileParseError {
  return new FileParseError(
    "too_many_rows",
    `A sheet has more than ${limits.maxRows} rows.`
  );
}

function tooManyColumns(limits: ParseLimits): FileParseError {
  return new FileParseError(
    "too_many_columns",
    `A sheet has more than ${limits.maxColumns} columns.`
  );
}

/**
 * The rows of `ws` inside the 1-based range (the whole sheet when `range` is omitted), read from
 * the cells that exist only, with trailing empty rows and columns trimmed. The first row is the
 * header; a value beyond the column limit, or past the header plus `maxRows` rows, fails at once,
 * before more is read.
 */
function readRange(
  ws: ExcelJS.Worksheet,
  limits: ParseLimits,
  range?: { top: number; left: number; bottom: number; right: number }
): Row[] {
  const top = range?.top ?? 1;
  const left = range?.left ?? 1;
  const cells = new Map<number, Map<number, string>>();
  let lastRow = 0;
  let width = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < top || (range && rowNumber > range.bottom)) return;
    const r = rowNumber - top + 1;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber < left || (range && colNumber > range.right)) return;
      const text = render(cell.value);
      if (text === null) return;
      const c = colNumber - left + 1;
      if (c > limits.maxColumns) throw tooManyColumns(limits);
      if (r > limits.maxRows + 1) throw tooManyRows(limits);
      let line = cells.get(r);
      if (!line) cells.set(r, (line = new Map()));
      line.set(c, text);
      if (r > lastRow) lastRow = r;
      if (c > width) width = c;
    });
  });
  const rows: Row[] = [];
  for (let r = 1; r <= lastRow; r += 1) {
    const line = cells.get(r);
    const row: Row = [];
    for (let c = 1; c <= width; c += 1) row.push(line?.get(c) ?? null);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads an xlsx workbook: each sheet, and each named table in addition (listed straight after its
 * sheet). Values are text (dates ISO 8601, formulas their cached value, a merged cell its top-left
 * value); trailing empty rows and columns are trimmed. The whole workbook is read into memory; the
 * caller bounds its compressed size and checks its ZIP directory first (`checkZipBounds`).
 */
export async function parseXlsx(
  stream: Readable,
  limits: ParseLimits
): Promise<ParsedSheet[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.read(stream);
  } catch (err) {
    throw new FileParseError(
      "malformed_xlsx",
      `The file is not a readable xlsx workbook: ${(err as Error).message}`
    );
  }

  const sheets: ParsedSheet[] = [];
  for (const ws of workbook.worksheets) {
    sheets.push({ name: ws.name, kind: "sheet", rows: readRange(ws, limits) });

    for (const entry of ws.getTables() as unknown as {
      table: { name: string; tableRef: string };
    }[]) {
      const [from, to] = entry.table.tableRef.split(":");
      const start = ws.getCell(from!);
      const end = ws.getCell(to ?? from!);
      const range = {
        top: Number(start.row),
        left: Number(start.col),
        bottom: Number(end.row),
        right: Number(end.col),
      };
      if (range.right - range.left + 1 > limits.maxColumns) {
        throw tooManyColumns(limits);
      }
      if (range.bottom - range.top > limits.maxRows) throw tooManyRows(limits);
      sheets.push({
        name: entry.table.name,
        kind: "table",
        rows: readRange(ws, limits, range),
      });
    }
  }
  return sheets;
}
