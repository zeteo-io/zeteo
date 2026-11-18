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

function trim(rows: Row[]): Row[] {
  let lastRow = rows.length;
  while (lastRow > 0 && rows[lastRow - 1]!.every((c) => c === null))
    lastRow -= 1;
  let width = 0;
  for (let r = 0; r < lastRow; r += 1) {
    for (let c = rows[r]!.length; c > width; c -= 1) {
      if (rows[r]![c - 1] !== null) {
        width = c;
        break;
      }
    }
  }
  return rows.slice(0, lastRow).map((row) => {
    const out = row.slice(0, width);
    while (out.length < width) out.push(null);
    return out;
  });
}

function checkLimits(rows: Row[], limits: ParseLimits): void {
  const width = rows[0]?.length ?? 0;
  if (width > limits.maxColumns) {
    throw new FileParseError(
      "too_many_columns",
      `A sheet has more than ${limits.maxColumns} columns.`
    );
  }
  if (rows.length - 1 > limits.maxRows) {
    throw new FileParseError(
      "too_many_rows",
      `A sheet has more than ${limits.maxRows} rows.`
    );
  }
}

function readRange(
  ws: ExcelJS.Worksheet,
  top: number,
  left: number,
  bottom: number,
  right: number,
  limits: ParseLimits
): Row[] {
  if (
    right - left + 1 > limits.maxColumns + 50 ||
    bottom - top > limits.maxRows + 1
  ) {
    // Refuse before materialising an absurd range; exact limits are checked after trimming.
    if (right - left + 1 > limits.maxColumns + 50) {
      throw new FileParseError(
        "too_many_columns",
        `A sheet has more than ${limits.maxColumns} columns.`
      );
    }
    throw new FileParseError(
      "too_many_rows",
      `A sheet has more than ${limits.maxRows} rows.`
    );
  }
  const rows: Row[] = [];
  for (let r = top; r <= bottom; r += 1) {
    const row: Row = [];
    for (let c = left; c <= right; c += 1)
      row.push(render(ws.getCell(r, c).value));
    rows.push(row);
  }
  return trim(rows);
}

/**
 * Reads an xlsx workbook: each sheet, and each named table in addition (listed straight after its
 * sheet). Values are text (dates ISO 8601, formulas their cached value, a merged cell its top-left
 * value); trailing empty rows and columns are trimmed. The workbook is read into memory, bounded
 * by the upload size limit.
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
    const rows = readRange(ws, 1, 1, ws.rowCount, ws.columnCount, limits);
    checkLimits(rows, limits);
    sheets.push({ name: ws.name, kind: "sheet", rows });

    for (const entry of ws.getTables() as unknown as {
      table: { name: string; tableRef: string };
    }[]) {
      const ref = ws.getCell(entry.table.tableRef.split(":")[0]!);
      const end = entry.table.tableRef.split(":")[1] ?? entry.table.tableRef;
      const endCell = ws.getCell(end);
      const tableRows = readRange(
        ws,
        Number(ref.row),
        Number(ref.col),
        Number(endCell.row),
        Number(endCell.col),
        limits
      );
      checkLimits(tableRows, limits);
      sheets.push({ name: entry.table.name, kind: "table", rows: tableRows });
    }
  }
  return sheets;
}
