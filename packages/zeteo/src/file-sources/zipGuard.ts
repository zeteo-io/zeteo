import { FileTooLargeError } from "../utils/errors.js";
import { FileParseError } from "./parse/types.js";
import { createInflateRaw } from "node:zlib";

/** An entry whose inflated size is over this is checked for its compression ratio; small entries compress wildly without harm. */
const RATIO_FLOOR_BYTES = 1024 * 1024;
/** More than this many inflated bytes per compressed byte is a bomb, not a workbook. */
export const MAX_RATIO = 100;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const malformed = () =>
  new FileParseError(
    "malformed_xlsx",
    "The file is not a readable xlsx workbook."
  );

const big = (n: bigint): number => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed();
  return Number(n);
};

/**
 * Reads a ZIP's central directory (no inflating) and refuses, with
 * `FileTooLargeError`, an archive whose declared uncompressed sizes add up to
 * more than `maxUncompressed` or any of whose larger entries inflates more
 * than 100 to 1: a zip bomb passes the upload's byte limit, which counts
 * compressed bytes. It then inflates every entry into a counter (output
 * discarded) and refuses at once an entry that inflates past its declared size
 * or a total past the limit, so an archive that understates its sizes cannot
 * reach the workbook reader. A damaged archive or an unknown compression
 * method is `malformed_xlsx`.
 */
export const checkZipBounds = async (
  zip: Buffer,
  maxUncompressed: number
): Promise<void> => {
  const entries = readEntries(zip, maxUncompressed);
  let total = 0;
  for (const entry of entries) {
    total += await inflatedSize(zip, entry, maxUncompressed - total);
    if (total > maxUncompressed) throw new FileTooLargeError(maxUncompressed);
  }
};

interface Entry {
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
}

/** The central directory's entries, after the checks on their declared sizes. */
const readEntries = (zip: Buffer, maxUncompressed: number): Entry[] => {
  let eocd = -1;
  for (
    let i = zip.length - 22;
    i >= Math.max(0, zip.length - 22 - 0xffff);
    i--
  ) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw malformed();

  let count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  let end = offset + zip.readUInt32LE(eocd + 12);
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || zip.readUInt32LE(loc) !== ZIP64_LOCATOR) throw malformed();
    const at = big(zip.readBigUInt64LE(loc + 8));
    if (at + 56 > zip.length || zip.readUInt32LE(at) !== ZIP64_EOCD) {
      throw malformed();
    }
    count = big(zip.readBigUInt64LE(at + 32));
    offset = big(zip.readBigUInt64LE(at + 48));
    end = offset + big(zip.readBigUInt64LE(at + 40));
  }
  if (end > zip.length) throw malformed();

  const entries: Entry[] = [];
  let total = 0;
  let pos = offset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || zip.readUInt32LE(pos) !== CENTRAL) throw malformed();
    let compressed = zip.readUInt32LE(pos + 20);
    let uncompressed = zip.readUInt32LE(pos + 24);
    let localOffset = zip.readUInt32LE(pos + 42);
    const method = zip.readUInt16LE(pos + 10);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw malformed();
    if (
      uncompressed === 0xffffffff ||
      compressed === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      // Zip64: the real sizes are in the extra field (id 1), in this order.
      let x = pos + 46 + nameLength;
      const extraEnd = x + extraLength;
      while (x + 4 <= extraEnd) {
        const id = zip.readUInt16LE(x);
        const size = zip.readUInt16LE(x + 2);
        if (id === 1) {
          let at = x + 4;
          if (uncompressed === 0xffffffff) {
            if (at + 8 > extraEnd) throw malformed();
            uncompressed = big(zip.readBigUInt64LE(at));
            at += 8;
          }
          if (compressed === 0xffffffff) {
            if (at + 8 > extraEnd) throw malformed();
            compressed = big(zip.readBigUInt64LE(at));
            at += 8;
          }
          if (localOffset === 0xffffffff) {
            if (at + 8 > extraEnd) throw malformed();
            localOffset = big(zip.readBigUInt64LE(at));
          }
          break;
        }
        x += 4 + size;
      }
    }
    total += uncompressed;
    if (total > maxUncompressed) throw new FileTooLargeError(maxUncompressed);
    if (
      uncompressed > RATIO_FLOOR_BYTES &&
      uncompressed > MAX_RATIO * Math.max(compressed, 1)
    ) {
      throw new FileTooLargeError(maxUncompressed);
    }
    entries.push({ method, compressed, uncompressed, localOffset });
    pos = next;
  }
  return entries;
};

/**
 * What an entry really inflates to, counted while discarding the output, so
 * memory stays flat. Fails with `FileTooLargeError` as soon as the count
 * passes the entry's declared size or `room`; a stored entry's size is its
 * compressed size, which must match the declared one.
 */
const inflatedSize = async (
  zip: Buffer,
  entry: Entry,
  room: number
): Promise<number> => {
  const at = entry.localOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL) throw malformed();
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  if (start + entry.compressed > zip.length) throw malformed();
  const data = zip.subarray(start, start + entry.compressed);
  const limit = Math.min(entry.uncompressed, room);
  if (entry.method === 0) {
    if (entry.compressed !== entry.uncompressed) throw malformed();
    return entry.compressed;
  }
  if (entry.method !== 8) throw malformed();
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
    inflate.end(data);
  });
};
