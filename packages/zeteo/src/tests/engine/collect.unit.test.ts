// @module-tag unit
// @module-tag platform
import { BATCH_BYTES, BATCH_ROWS, collect } from "../../engine/collect.js";
import type { RowStream } from "../../adapters/types.js";
import { describe, expect, it, vi } from "vitest";

/** A stream over `rows` that gives at most `per` rows a call, and records what it was asked for. */
const fakeStream = (rows: unknown[][], per = Infinity) => {
  const asked: number[] = [];
  let at = 0;
  const stream: RowStream = {
    columns: [{ name: "v", type: "text" }],
    next: async (maxRows) => {
      asked.push(maxRows);
      const batch = rows.slice(at, at + Math.min(maxRows, per));
      at += batch.length;
      return batch;
    },
    close: vi.fn(async () => undefined),
  };
  return { stream, asked };
};

/** What a row costs against `maxBytes`: its JSON and the comma after it. */
const sizeOf = (row: unknown[]) => Buffer.byteLength(JSON.stringify(row)) + 1;

const numbered = (n: number, width = 1) =>
  Array.from({ length: n }, (_, i) => [String(i).padEnd(width, "x")]);

const LARGE = { maxRows: 1_000_000, maxBytes: 1024 * 1024 * 1024 };

describe("collect", () => {
  it("stops at maxRows when one more row exists, and says so", async () => {
    const { stream } = fakeStream(numbered(6));
    const result = await collect(stream, { ...LARGE, maxRows: 5 });
    expect(result).toEqual({ rows: numbered(5), truncated: "rows" });
  });

  it("does not report truncation when the rows end at maxRows", async () => {
    const { stream } = fakeStream(numbered(5));
    const result = await collect(stream, { ...LARGE, maxRows: 5 });
    expect(result).toEqual({ rows: numbered(5), truncated: false });
  });

  it("leaves out the row that would pass maxBytes, and every row after it", async () => {
    const rows = numbered(4, 10);
    const { stream } = fakeStream(rows);
    const result = await collect(stream, {
      ...LARGE,
      maxBytes: sizeOf(rows[0]!) + sizeOf(rows[1]!) - 1,
    });
    expect(result).toEqual({ rows: [rows[0]], truncated: "bytes" });
  });

  it("keeps every row when they fit maxBytes exactly", async () => {
    const rows = numbered(4, 10);
    const { stream } = fakeStream(rows);
    const result = await collect(stream, {
      ...LARGE,
      maxBytes: rows.reduce((sum, row) => sum + sizeOf(row), 0),
    });
    expect(result).toEqual({ rows, truncated: false });
  });

  it("keeps no row when the first is over maxBytes", async () => {
    const rows = numbered(3, 100);
    const { stream } = fakeStream(rows);
    const result = await collect(stream, { ...LARGE, maxBytes: 50 });
    expect(result).toEqual({ rows: [], truncated: "bytes" });
  });

  it("asks for one row first, then as many of the average size so far as fit BATCH_BYTES", async () => {
    const width = 300 * 1024;
    const rows = numbered(10, width);
    const { stream, asked } = fakeStream(rows);
    const result = await collect(stream, LARGE);
    expect(result.rows).toHaveLength(10);
    const fit = Math.floor(BATCH_BYTES / sizeOf(rows[0]!));
    expect(fit).toBe(3);
    expect(asked).toEqual([1, fit, fit, fit, fit]);
  });

  it("asks for at most BATCH_ROWS at a time, however narrow the rows", async () => {
    const { stream, asked } = fakeStream(numbered(600));
    await collect(stream, LARGE);
    // 1 + 250 + 250 + 99 rows, then the empty batch that ends it.
    expect(asked).toEqual([1, BATCH_ROWS, BATCH_ROWS, BATCH_ROWS, BATCH_ROWS]);
  });

  it("never asks for more than one row past maxRows in all", async () => {
    const { stream, asked } = fakeStream(numbered(600));
    const result = await collect(stream, { ...LARGE, maxRows: 300 });
    expect(result.truncated).toBe("rows");
    expect(asked).toEqual([1, BATCH_ROWS, 300 + 1 - 1 - BATCH_ROWS]);
  });

  it("reads on when a batch is short but the stream has not ended", async () => {
    const { stream, asked } = fakeStream(numbered(7), 2);
    const result = await collect(stream, LARGE);
    expect(result).toEqual({ rows: numbered(7), truncated: false });
    // 1 + 2 + 2 + 2 rows, then the empty batch that ends it.
    expect(asked).toHaveLength(5);
  });

  it("does not close the stream", async () => {
    const { stream } = fakeStream(numbered(3));
    await collect(stream, { ...LARGE, maxRows: 1 });
    await collect(fakeStream(numbered(3)).stream, LARGE);
    expect(stream.close).not.toHaveBeenCalled();
  });

  it("rejects as the stream does", async () => {
    const failure = new Error("gone");
    const stream: RowStream = {
      columns: [],
      next: vi
        .fn()
        .mockResolvedValueOnce([["a"]])
        .mockRejectedValueOnce(failure),
      close: async () => undefined,
    };
    await expect(collect(stream, LARGE)).rejects.toBe(failure);
  });
});
