import type { ColumnType } from "../adapters/types.js";

const CRLF = "\r\n";

// A spreadsheet reads a cell starting with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** A field as RFC 4180 writes it: quoted, with `"` doubled, when it holds `"`, `,`, CR or LF. */
const field = (text: string): string =>
  NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

/** Text a spreadsheet would run as a formula, with a leading `'` that keeps it text. */
const guarded = (text: string): string =>
  FORMULA_START.test(text) ? `'${text}` : text;

const cell = (value: unknown, type: ColumnType): string => {
  if (value === null || value === undefined) return "";
  switch (type) {
    // Numbers (64-bit integers and decimals arrive as strings), booleans,
    // dates and timestamps: their own text, never a formula.
    case "number":
    case "boolean":
    case "date":
    case "timestamp":
      return field(String(value));
    case "json":
      return field(guarded(JSON.stringify(value)));
    case "text":
    case "other":
      // Quoted, so an empty string is not read back as null.
      if (value === "") return '""';
      return field(
        guarded(typeof value === "string" ? value : JSON.stringify(value))
      );
  }
};

/** The header record: the column names, CRLF-terminated. */
export const csvHeader = (columns: { name: string }[]): string =>
  columns.map((c) => field(c.name)).join(",") + CRLF;

/** One row as a CRLF-terminated record; `columns` gives each value's type. */
export const csvRow = (
  row: unknown[],
  columns: { type: ColumnType }[]
): string => row.map((v, i) => cell(v, columns[i]!.type)).join(",") + CRLF;
