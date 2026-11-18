// @module-tag unit
// @module-tag platform
import { checkZipBounds } from "../../file-sources/zipGuard.js";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";

const zipOf = async (files: Record<string, Buffer>) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};

/** Random text over four letters: about 4:1 when deflated. */
const text = (bytes: number) =>
  Buffer.from(Array.from(randomBytes(bytes), (b) => "acgt"[b & 3]).join(""));

describe("checkZipBounds", () => {
  it("passes a workbook-sized archive", async () => {
    const zip = await zipOf({ "a.xml": text(10_000), "b.xml": text(10_000) });
    expect(() => checkZipBounds(zip, 100_000)).not.toThrow();
  });

  it("refuses declared sizes adding up past the limit", async () => {
    const zip = await zipOf({ "a.xml": text(200_000), "b.xml": text(200_000) });
    expect(() => checkZipBounds(zip, 300_000)).toThrowError(
      expect.objectContaining({ code: "file_too_large", statusCode: 413 })
    );
    expect(() => checkZipBounds(zip, 500_000)).not.toThrow();
  });

  it("refuses an entry compressing over 100 to 1", async () => {
    const zip = await zipOf({ "bomb.bin": Buffer.alloc(8 * 1024 * 1024) });
    expect(zip.length).toBeLessThan(100_000);
    expect(() => checkZipBounds(zip, 1_000_000_000)).toThrowError(
      expect.objectContaining({ code: "file_too_large" })
    );
  });

  it("lets a small entry compress as much as it likes", async () => {
    const zip = await zipOf({ "a.xml": Buffer.alloc(100_000) });
    expect(() => checkZipBounds(zip, 1_000_000)).not.toThrow();
  });

  it("calls a damaged archive malformed_xlsx", () => {
    expect(() =>
      checkZipBounds(Buffer.from("PK\x03\x04 nothing"), 1000)
    ).toThrowError(expect.objectContaining({ code: "malformed_xlsx" }));
  });
});
