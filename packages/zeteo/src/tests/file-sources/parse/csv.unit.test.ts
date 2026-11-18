// @module-tag unit
// @module-tag platform

import { FileParseError } from "../../../file-sources/parse/types.js";
import { parseCsv } from "../../../file-sources/parse/csv.js";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

const limits = { maxRows: 100, maxColumns: 10 };

function fixture(name: string): Buffer {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/files/${name}`, import.meta.url))
  );
}

async function collect(
  bytes: Buffer | string,
  l = limits
): Promise<(string | null)[][]> {
  const out: (string | null)[][] = [];
  for await (const row of parseCsv(Readable.from([Buffer.from(bytes)]), l)) {
    out.push(row);
  }
  return out;
}

describe("parseCsv", () => {
  it("reads a plain file and turns empty cells into null", async () => {
    expect(await collect("a,b\n1,\n,x\n")).toEqual([
      ["a", "b"],
      ["1", null],
      [null, "x"],
    ]);
  });

  it("keeps leading-zero ZIPs as text values", async () => {
    const rows = await collect(fixture("zips.csv"));
    expect(rows[1]?.[0]).toBe("02134");
  });

  it("strips a UTF-8 BOM", async () => {
    const rows = await collect(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("a,b\n1,2\n"),
      ])
    );
    expect(rows[0]).toEqual(["a", "b"]);
  });

  it("reads UTF-16LE with BOM", async () => {
    const rows = await collect(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("a,b\né,2\n", "utf16le"),
      ])
    );
    expect(rows).toEqual([
      ["a", "b"],
      ["é", "2"],
    ]);
  });

  it("reads UTF-16BE with BOM", async () => {
    const le = Buffer.from("a,b\né,2\n", "utf16le");
    const be = Buffer.from(le).swap16();
    const rows = await collect(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    expect(rows[1]).toEqual(["é", "2"]);
  });

  it("refuses latin-1 without BOM", async () => {
    await expect(collect(fixture("latin1.csv"))).rejects.toMatchObject({
      name: "FileParseError",
      code: "unsupported_encoding",
    });
  });

  it("detects semicolons", async () => {
    const rows = await collect(fixture("semicolons.csv"));
    expect(rows[0]).toEqual(["name", "age"]);
  });

  it("detects tabs and pipes", async () => {
    expect((await collect("a\tb\n1\t2\n"))[0]).toEqual(["a", "b"]);
    expect((await collect("a|b\n1|2\n"))[0]).toEqual(["a", "b"]);
  });

  it("ignores delimiters inside quotes when detecting", async () => {
    const rows = await collect('"a,b,c";d\n1;2\n');
    expect(rows[0]).toEqual(["a,b,c", "d"]);
  });

  it("pads short rows", async () => {
    const rows = await collect("a,b,c\n1,2\n");
    expect(rows[1]).toEqual(["1", "2", null]);
  });

  it("long row errors with its row number", async () => {
    const err = await collect(fixture("ragged.csv")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileParseError);
    expect(err).toMatchObject({ code: "row_too_long", row: 3 });
  });

  it("errors on too many columns", async () => {
    await expect(
      collect("a,b,c\n1,2,3\n", { maxRows: 10, maxColumns: 2 })
    ).rejects.toMatchObject({ code: "too_many_columns" });
  });

  it("errors on too many rows (header not counted)", async () => {
    await expect(
      collect("a\n1\n2\n3\n", { maxRows: 2, maxColumns: 5 })
    ).rejects.toMatchObject({
      code: "too_many_rows",
    });
    expect(
      await collect("a\n1\n2\n", { maxRows: 2, maxColumns: 5 })
    ).toHaveLength(3);
  });

  it("skips blank lines and handles quoted newlines", async () => {
    const rows = await collect('a,b\n\n"x\ny",2\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x\ny", "2"],
    ]);
  });

  it("refuses a NUL past the sniffed head as invalid_character, with its row", async () => {
    // Far enough in that the type sniff and the encoding check never see it.
    const body = Array.from({ length: 5000 }, (_, i) => `${i},row ${i}`);
    body[4000] = "4000,bad\0value";
    const err = await collect(`id,name\n${body.join("\n")}\n`, {
      maxRows: 10_000,
      maxColumns: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileParseError);
    expect(err).toMatchObject({ code: "invalid_character", row: 4002 });
  });

  it("reports malformed quoting as a parse error", async () => {
    await expect(collect('a,b\n"x,2\n1"z,3\n')).rejects.toBeInstanceOf(
      FileParseError
    );
  });
});
