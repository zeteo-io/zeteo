import { lines, MAX_LINE_BYTES } from "../ndjson.js";
import { describe, expect, it } from "vitest";

async function* from(chunks: (Buffer | string)[]) {
  for (const chunk of chunks) yield chunk;
}

const collect = async (chunks: (Buffer | string)[]): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const value of lines(from(chunks))) out.push(value);
  return out;
};

describe("lines", () => {
  it("joins a line split across chunks", async () => {
    expect(await collect(['{"a"', ":1}\n[1,", "2]\n[3]\n"])).toEqual([
      { a: 1 },
      [1, 2],
      [3],
    ]);
  });

  it("keeps a 2-byte and a 4-byte character split across chunks intact", async () => {
    const bytes = Buffer.from('["é","😀"]\n');
    const e = bytes.indexOf(0xc3);
    const emoji = bytes.indexOf(0xf0);
    const chunks = [
      bytes.subarray(0, e + 1),
      bytes.subarray(e + 1, emoji + 2),
      bytes.subarray(emoji + 2, emoji + 3),
      bytes.subarray(emoji + 3),
    ];
    expect(await collect(chunks)).toEqual([["é", "😀"]]);
  });

  it("does not treat CR specially", async () => {
    expect(await collect(['["a\\r"]\r\n', "[1]\n"])).toEqual([["a\r"], [1]]);
    await expect(collect(["[1]\r[2]\n"])).rejects.toThrow(SyntaxError);
  });

  it("does not yield a final unterminated fragment", async () => {
    expect(await collect(["[1]\n[2]"])).toEqual([[1]]);
  });

  it("throws on a line over the cap", async () => {
    const big = Buffer.alloc(1024 * 1024, 0x20);
    const chunks = Array.from(
      { length: MAX_LINE_BYTES / big.length + 1 },
      () => big
    );
    await expect(collect(chunks)).rejects.toThrow(/longer than/);
    await expect(collect([" ".repeat(MAX_LINE_BYTES) + "1\n"])).rejects.toThrow(
      /longer than/
    );
  });
});
