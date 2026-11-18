// @module-tag unit
// @module-tag platform
import { checkZipBounds, zipEntries } from "../../file-sources/zipGuard.js";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const zipOf = async (files: Record<string, Buffer>) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};

/** Random text over four letters: about 4:1 when deflated. */
const text = (bytes: number) =>
  Buffer.from(Array.from(randomBytes(bytes), (b) => "acgt"[b & 3]).join(""));

const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** A one-entry archive whose directory says `bomb.bin` (8 MiB of zeros) inflates to 1000 bytes. */
const understatedBomb = async () => {
  const zip = await zipOf({ "bomb.bin": Buffer.alloc(8 * 1024 * 1024) });
  zip.writeUInt32LE(1000, zip.lastIndexOf(CENTRAL) + 24);
  return zip;
};

/** The names JSZip itself (as ExcelJS calls it) finds in `zip`, directories left out. */
const jszipNames = async (zip: Buffer) =>
  Object.values((await JSZip.loadAsync(zip)).files)
    .filter((f) => !f.dir)
    .map((f) => f.name)
    .sort();

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
    await expect(
      checkZipBounds(await understatedBomb(), 1_000_000_000)
    ).rejects.toMatchObject({ code: "file_too_large", statusCode: 413 });
  });

  it("refuses an unknown compression method", async () => {
    const zip = await zipOf({ "a.xml": text(1000) });
    zip.writeUInt16LE(99, zip.lastIndexOf(CENTRAL) + 10);
    await expect(checkZipBounds(zip, 1_000_000)).rejects.toMatchObject({
      code: "malformed_xlsx",
    });
  });

  it("calls a damaged archive malformed_xlsx", async () => {
    await expect(
      checkZipBounds(Buffer.from("PK\x03\x04 nothing"), 1000)
    ).rejects.toMatchObject({ code: "malformed_xlsx" });
  });

  it("counts the hidden directory a zip64 decoy points JSZip to", async () => {
    // A decoy archive (one harmless entry) whose end record has diskNumber
    // 0xFFFF: JSZip then ignores the end record's directory and follows the
    // zip64 locator to a second, hidden directory naming the bomb.
    const decoy = await zipOf({ "decoy.xml": text(100) });
    const decoyBody = decoy.subarray(0, decoy.lastIndexOf(EOCD));
    const decoyDir = decoy.readUInt32LE(decoy.lastIndexOf(EOCD) + 16);

    const bomb = await understatedBomb();
    const bombDirAt = bomb.readUInt32LE(bomb.lastIndexOf(EOCD) + 16);
    const bombLocal = bomb.subarray(0, bombDirAt);
    const bombDir = Buffer.from(
      bomb.subarray(bombDirAt, bomb.lastIndexOf(EOCD))
    );
    bombDir.writeUInt32LE(decoyBody.length, 42); // local header offset

    const hiddenDirAt = decoyBody.length + bombLocal.length;
    const zip64EocdAt = hiddenDirAt + bombDir.length;
    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(0x06064b50, 0);
    zip64Eocd.writeBigUInt64LE(44n, 4);
    zip64Eocd.writeBigUInt64LE(1n, 24); // records on this disk
    zip64Eocd.writeBigUInt64LE(1n, 32); // records
    zip64Eocd.writeBigUInt64LE(BigInt(bombDir.length), 40);
    zip64Eocd.writeBigUInt64LE(BigInt(hiddenDirAt), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(zip64EocdAt), 8);
    locator.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 4); // diskNumber
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(decoyBody.length - decoyDir, 12);
    eocd.writeUInt32LE(decoyDir, 16);
    const zip = Buffer.concat([
      decoyBody,
      bombLocal,
      bombDir,
      zip64Eocd,
      locator,
      eocd,
    ]);

    expect(await jszipNames(zip)).toEqual(["bomb.bin"]);
    expect((await zipEntries(zip)).map((e) => e.name)).toEqual(["bomb.bin"]);
    await expect(checkZipBounds(zip, 1_000_000_000)).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  it("counts entries where JSZip finds them after bytes before the archive", async () => {
    // Bytes in front move the end record past where the directory says it
    // ends; JSZip rebases every offset by the gap and reads the bomb there.
    const zip = Buffer.concat([
      Buffer.alloc(4096, 0x20),
      await understatedBomb(),
    ]);
    const eocd = zip.lastIndexOf(EOCD);
    expect(
      eocd - (zip.readUInt32LE(eocd + 16) + zip.readUInt32LE(eocd + 12))
    ).toBe(4096);
    expect(await jszipNames(zip)).toEqual(["bomb.bin"]);
    await expect(checkZipBounds(zip, 1_000_000_000)).rejects.toMatchObject({
      code: "file_too_large",
    });
  });
});

describe("zipEntries", () => {
  it("reads JSZip's parse of a real workbook (fails if JSZip's internals change)", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("One").addRow(["a", 1, new Date(0)]);
    const zip = Buffer.from(await wb.xlsx.writeBuffer());
    const loaded = await JSZip.loadAsync(zip);
    const files = Object.values(loaded.files).filter((f) => !f.dir);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const data = (file as unknown as { _data: Record<string, unknown> })
        ._data;
      expect(data).toMatchObject({
        compression: { magic: expect.toBeOneOf(["\x00\x00", "\x08\x00"]) },
        compressedContent: expect.any(Uint8Array),
        uncompressedSize: expect.any(Number),
      });
    }
    const entries = await zipEntries(zip);
    expect(entries.map((e) => e.name).sort()).toEqual(
      files.map((f) => f.name).sort()
    );
    for (const entry of entries) {
      const real = await loaded.file(entry.name)!.async("nodebuffer");
      expect(entry.uncompressed).toBe(real.length);
    }
    await expect(checkZipBounds(zip, 10_000_000)).resolves.toBeUndefined();
  });
});
