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
    await expect(checkZipBounds(zip, 100_000)).resolves.toBeUndefined();
  });

  it("refuses declared sizes adding up past the limit", async () => {
    const zip = await zipOf({ "a.xml": text(200_000), "b.xml": text(200_000) });
    await expect(checkZipBounds(zip, 300_000)).rejects.toMatchObject({
      code: "file_too_large",
      statusCode: 413,
    });
    await expect(checkZipBounds(zip, 500_000)).resolves.toBeUndefined();
  });

  it("refuses an entry compressing over 100 to 1", async () => {
    const zip = await zipOf({ "bomb.bin": Buffer.alloc(8 * 1024 * 1024) });
    expect(zip.length).toBeLessThan(100_000);
    await expect(checkZipBounds(zip, 1_000_000_000)).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  it("lets a small entry compress as much as it likes", async () => {
    const zip = await zipOf({ "a.xml": Buffer.alloc(100_000) });
    await expect(checkZipBounds(zip, 1_000_000)).resolves.toBeUndefined();
  });

  it("refuses an entry that inflates past the size its directory declares", async () => {
    const zip = await zipOf({ "a.bin": Buffer.alloc(900_000) });
    // The central directory is last; its entry's uncompressed size sits 24 bytes in.
    const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(1000, central + 24);
    await expect(checkZipBounds(zip, 1_000_000_000)).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  it("refuses an unknown compression method", async () => {
    const zip = await zipOf({ "a.xml": text(1000) });
    const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(99, central + 10);
    await expect(checkZipBounds(zip, 1_000_000)).rejects.toMatchObject({
      code: "malformed_xlsx",
    });
  });

  it("calls a damaged archive malformed_xlsx", async () => {
    await expect(
      checkZipBounds(Buffer.from("PK\x03\x04 nothing"), 1000)
    ).rejects.toMatchObject({ code: "malformed_xlsx" });
  });
});
