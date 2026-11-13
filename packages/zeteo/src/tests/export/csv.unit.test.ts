// @module-tag unit
// @module-tag platform
import { readCsv, readCsvValues } from "../support/pure/csv.js";
import type { ColumnType } from "../../adapters/types.js";
import { csvHeader, csvRow } from "../../export/csv.js";
import { describe, expect, it } from "vitest";

const typed = (...types: ColumnType[]) => types.map((type) => ({ type }));

describe("csvHeader", () => {
  it("writes the column names as one CRLF-terminated record, quoted when needed", () => {
    const header = csvHeader([
      { name: "id" },
      { name: "a,b" },
      { name: 'say "hi"' },
    ]);
    expect(header).toBe('id,"a,b","say ""hi"""\r\n');
    expect(readCsvValues(header)).toEqual([["id", "a,b", 'say "hi"']]);
  });
});

describe("csvRow", () => {
  it("quotes a value holding a quote, a comma, CR or LF, and reads back exactly", () => {
    const values = [
      'he said "no"',
      "a,b",
      "line\r\nnext",
      "cr\ronly",
      "lf\nonly",
    ];
    const row = csvRow(values, typed(...values.map(() => "text" as const)));
    expect(row).toBe(
      '"he said ""no""","a,b","line\r\nnext","cr\ronly","lf\nonly"\r\n'
    );
    expect(readCsvValues(row)).toEqual([values]);
  });

  it("leaves a plain value unquoted", () => {
    expect(csvRow(["Acme", 7], typed("text", "number"))).toBe("Acme,7\r\n");
  });

  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"])(
    "guards a text value starting with %j with a leading quote mark",
    (value) => {
      const [[field]] = readCsvValues(csvRow([value], typed("text")));
      expect(field).toBe(`'${value}`);
    }
  );

  it("guards a value of a column whose type is other, as text", () => {
    expect(readCsvValues(csvRow(["=1"], typed("other")))).toEqual([["'=1"]]);
  });

  it("never guards a number, boolean, date or timestamp", () => {
    const row = csvRow(
      [
        -42,
        "-9223372036854775808",
        "-0.50",
        "-Infinity",
        false,
        "2026-03-31",
        "2026-03-31T23:59:59.999Z",
      ],
      typed(
        "number",
        "number",
        "number",
        "number",
        "boolean",
        "date",
        "timestamp"
      )
    );
    expect(row).toBe(
      "-42,-9223372036854775808,-0.50,-Infinity,false,2026-03-31,2026-03-31T23:59:59.999Z\r\n"
    );
  });

  it("writes booleans as true and false", () => {
    expect(csvRow([true, false], typed("boolean", "boolean"))).toBe(
      "true,false\r\n"
    );
  });

  it("writes json as its JSON text, quoted as any other value", () => {
    const row = csvRow(
      [{ a: [1, 2] }, [], "text", 1.5],
      typed("json", "json", "json", "json")
    );
    expect(readCsvValues(row)).toEqual([
      ['{"a":[1,2]}', "[]", '"text"', "1.5"],
    ]);
  });

  it("guards json text that starts with a guarded character", () => {
    expect(readCsvValues(csvRow([-1], typed("json")))).toEqual([["'-1"]]);
  });

  it("writes null as an empty field and an empty string as a quoted empty one", () => {
    const row = csvRow([null, "", null], typed("text", "text", "number"));
    expect(row).toBe(',"",\r\n');
    expect(readCsv(row)).toEqual([
      [
        { value: "", quoted: false },
        { value: "", quoted: true },
        { value: "", quoted: false },
      ],
    ]);
  });

  it("keeps characters outside the Basic Multilingual Plane whole", () => {
    const values = ["zß😀", "𝄞,𝄢", '"🎉"'];
    const row = csvRow(values, typed("text", "text", "text"));
    expect(readCsvValues(row)).toEqual([values]);
    expect(Buffer.from(row, "utf8").toString("utf8")).toBe(row);
  });
});
