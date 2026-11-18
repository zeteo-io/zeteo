export type ParseLimits = { maxRows: number; maxColumns: number };

export type FileParseErrorCode =
  | "unsupported_encoding"
  | "invalid_character"
  | "row_too_long"
  | "too_many_columns"
  | "too_many_rows"
  | "malformed_csv"
  | "malformed_xlsx";

/** A file that cannot be read; `row` is the 1-based row (the header is row 1). */
export class FileParseError extends Error {
  readonly code: FileParseErrorCode;
  readonly row?: number;

  constructor(code: FileParseErrorCode, message: string, row?: number) {
    super(message);
    this.name = "FileParseError";
    this.code = code;
    if (row !== undefined) this.row = row;
  }
}

export type Row = (string | null)[];

export type ParsedSheet = {
  name: string;
  kind: "sheet" | "table";
  rows: AsyncIterable<Row> | Row[];
};
