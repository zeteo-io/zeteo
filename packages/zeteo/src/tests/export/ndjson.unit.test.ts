// @module-tag unit
// @module-tag platform
import { ndjsonHead, ndjsonRow, ndjsonTail } from "../../export/ndjson.js";
import { describe, expect, it } from "vitest";

describe("ndjson lines", () => {
  it("writes the head as columns, warnings and run_id, on one line", () => {
    const line = ndjsonHead({
      columns: [
        { name: "id", type: "number" },
        { name: "name", type: "text" },
      ],
      warnings: [
        { code: "join_multiplies_rows", message: "m", path: ["join", 0] },
      ],
      runId: "run-1",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({
      columns: [
        { name: "id", type: "number" },
        { name: "name", type: "text" },
      ],
      warnings: [
        { code: "join_multiplies_rows", message: "m", path: ["join", 0] },
      ],
      run_id: "run-1",
    });
    expect(Object.keys(JSON.parse(line))).toEqual([
      "columns",
      "warnings",
      "run_id",
    ]);
  });

  it("writes a row as one JSON array in its wire forms, newlines escaped", () => {
    const row = [1, "a\nb\r\nc", null, "9007199254740993", { x: "😀" }, true];
    const line = ndjsonRow(row);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual(row);
  });

  it.each([
    ["complete", 3],
    ["truncated", 0],
  ] as const)(
    "writes the tail as status %s and the row count",
    (status, rows) => {
      const line = ndjsonTail({ status, rows });
      expect(line).toBe(`{"status":"${status}","rows":${rows}}\n`);
    }
  );
});
