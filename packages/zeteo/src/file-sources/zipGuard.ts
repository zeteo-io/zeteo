import { FileTooLargeError } from "../utils/errors.js";
import { FileParseError } from "./parse/types.js";
import { createInflateRaw } from "node:zlib";
import JSZip from "jszip";

/** An entry whose inflated size is over this is checked for its compression ratio; small entries compress wildly without harm. */
const RATIO_FLOOR_BYTES = 1024 * 1024;
/** More than this many inflated bytes per compressed byte is a bomb, not a workbook. */
export const MAX_RATIO = 100;

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
 * entries and the reader another. Declared sizes are checked first (their sum,
 * and no entry over 1 MiB inflating more than 100 to 1); then every entry is
 * inflated into a counter, output discarded so memory stays flat, and refused
 * as soon as it passes its declared size (which JSZip's reader would only
 * notice after holding it all) or the total passes the limit. A damaged
 * archive or a compression other than stored or deflate is `malformed_xlsx`.
 */
export const checkZipBounds = async (
  zip: Buffer,
  maxUncompressed: number
): Promise<void> => {
  const entries = await zipEntries(zip);
  let declared = 0;
  for (const entry of entries) {
    declared += entry.uncompressed;
    if (declared > maxUncompressed) {
      throw new FileTooLargeError(maxUncompressed);
    }
    if (
      entry.uncompressed > RATIO_FLOOR_BYTES &&
      entry.uncompressed > MAX_RATIO * Math.max(entry.compressed.length, 1)
    ) {
      throw new FileTooLargeError(maxUncompressed);
    }
  }
  let total = 0;
  for (const entry of entries) {
    total += await inflatedSize(entry, maxUncompressed - total);
    if (total > maxUncompressed) throw new FileTooLargeError(maxUncompressed);
  }
};

/**
 * What an entry really inflates to, counted while discarding the output.
 * Fails with `FileTooLargeError` as soon as the count passes the entry's
 * declared size or `room`; a stored entry's size is its compressed length,
 * which must match the declared one.
 */
const inflatedSize = async (
  entry: ZipEntryData,
  room: number
): Promise<number> => {
  if (entry.method === "stored") {
    if (entry.compressed.length !== entry.uncompressed) throw malformed();
    return entry.uncompressed;
  }
  const limit = Math.min(entry.uncompressed, room);
  return new Promise<number>((resolve, reject) => {
    const inflate = createInflateRaw();
    let size = 0;
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      if (err) {
        inflate.destroy();
        reject(err);
      } else resolve(size);
    };
    inflate.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish(new FileTooLargeError(limit));
    });
    inflate.on("end", () => finish(null));
    inflate.on("error", () => finish(malformed()));
    inflate.end(entry.compressed);
  });
};
