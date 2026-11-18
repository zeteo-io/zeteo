import { FileTooLargeError } from "../utils/errors.js";
import { FileParseError } from "./parse/types.js";
import { createInflateRaw } from "node:zlib";
import JSZip from "jszip";

const STORED = "\x00\x00";
const DEFLATE = "\x08\x00";

const malformed = () =>
  new FileParseError(
    "malformed_xlsx",
    "The file is not a readable xlsx workbook."
  );

/** What the guard reads from JSZip's own parse of an entry. */
export interface ZipEntryData {
  name: string;
  method: "stored" | "deflate";
  compressed: Uint8Array;
  uncompressed: number;
}

/**
 * The compressed data of every file entry, exactly as JSZip parsed it: ExcelJS
 * (`xlsx.load`) calls `JSZip.loadAsync(buffer)` with no options on the same
 * bytes, so these are the entries, and the bytes, that the workbook reader
 * would inflate. Directory entries are skipped, as ExcelJS skips them. JSZip
 * internals that are not as expected fail closed (`malformed_xlsx`).
 */
export const zipEntries = async (zip: Buffer): Promise<ZipEntryData[]> => {
  let loaded: JSZip;
  try {
    loaded = await JSZip.loadAsync(zip);
  } catch {
    throw malformed();
  }
  const entries: ZipEntryData[] = [];
  for (const file of Object.values(loaded.files)) {
    if (file.dir) continue;
    const data = (file as unknown as { _data?: unknown })._data as
      | {
          compression?: { magic?: unknown };
          compressedContent?: unknown;
          uncompressedSize?: unknown;
        }
      | null
      | undefined;
    const magic = data?.compression?.magic;
    const compressed = data?.compressedContent;
    const uncompressed = data?.uncompressedSize;
    if (
      (magic !== STORED && magic !== DEFLATE) ||
      !(compressed instanceof Uint8Array) ||
      typeof uncompressed !== "number" ||
      !Number.isSafeInteger(uncompressed) ||
      uncompressed < 0
    ) {
      throw malformed();
    }
    entries.push({
      name: file.name,
      method: magic === STORED ? "stored" : "deflate",
      compressed,
      uncompressed,
    });
  }
  return entries;
};

/**
 * Refuses, with `FileTooLargeError`, a workbook whose entries would inflate to
 * more than `maxUncompressed` in all: a zip bomb passes the upload's byte
 * limit, which counts compressed bytes. The entries are the ones JSZip itself
 * finds (`zipEntries`), so no crafted directory can show this check one set of
 * entries and the reader another. The sum of the declared sizes is checked
 * first; then every entry is inflated into a counter, output discarded so
 * memory stays flat, and refused as soon as it passes its declared size
 * (which JSZip's reader would only notice after holding it all) or the total
 * passes the limit. No compression ratio is refused as such: counting the
 * real inflated bytes bounds a bomb, and a repetitive workbook may compress
 * very well. A damaged archive or a compression other than stored or deflate
 * is `malformed_xlsx`. The refusal's `max_bytes` is `maxBytes`, the upload
 * limit, and its message speaks of the workbook's uncompressed content.
 */
export const checkZipBounds = async (
  zip: Buffer,
  maxUncompressed: number,
  maxBytes: number = maxUncompressed
): Promise<void> => {
  const tooLarge = () => new FileTooLargeError(maxBytes, maxUncompressed);
  const entries = await zipEntries(zip);
  let declared = 0;
  for (const entry of entries) {
    declared += entry.uncompressed;
    if (declared > maxUncompressed) throw tooLarge();
  }
  let total = 0;
  for (const entry of entries) {
    const size = await inflatedSize(entry, maxUncompressed - total);
    if (size === null) throw tooLarge();
    total += size;
    if (total > maxUncompressed) throw tooLarge();
  }
};

/**
 * What an entry really inflates to, counted while discarding the output, or
 * null as soon as the count passes the entry's declared size or `room`; a
 * stored entry's size is its compressed length, which must match the
 * declared one.
 */
const inflatedSize = async (
  entry: ZipEntryData,
  room: number
): Promise<number | null> => {
  if (entry.method === "stored") {
    if (entry.compressed.length !== entry.uncompressed) throw malformed();
    return entry.uncompressed;
  }
  const limit = Math.min(entry.uncompressed, room);
  return new Promise<number | null>((resolve, reject) => {
    const inflate = createInflateRaw();
    let size = 0;
    let done = false;
    const finish = (err: Error | null, result: number | null = size) => {
      if (done) return;
      done = true;
      if (err) {
        inflate.destroy();
        reject(err);
      } else {
        if (result === null) inflate.destroy();
        resolve(result);
      }
    };
    inflate.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish(null, null);
    });
    inflate.on("end", () => finish(null));
    inflate.on("error", () => finish(malformed()));
    inflate.end(entry.compressed);
  });
};
