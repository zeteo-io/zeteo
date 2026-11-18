import type { ParseLimits, Row } from "./types.js";
import { FileParseError } from "./types.js";
import { Readable } from "node:stream";
import { parse } from "csv-parse";

const SNIFF_BYTES = 64 * 1024;
const DELIMITERS = [",", ";", "\t", "|"] as const;

type Encoding = "utf-8" | "utf-16le" | "utf-16be";

function detectEncoding(head: Buffer): Encoding {
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  // Without a BOM, only UTF-8 is accepted; anything else is refused rather than guessed.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    throw new FileParseError(
      "unsupported_encoding",
      "The file is not UTF-8 or UTF-16 with a byte order mark."
    );
  }
  return "utf-8";
}

/** The delimiter that appears most in the first line, outside quotes. */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === "\n" || ch === "\r") {
        if (Array.from(counts.values()).some((n) => n > 0)) break;
      } else if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
    }
  }
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    if (counts.get(d)! > bestCount) {
      best = d;
      bestCount = counts.get(d)!;
    }
  }
  return best;
}

function decodeError(): FileParseError {
  return new FileParseError(
    "unsupported_encoding",
    "The file is not valid in its encoding."
  );
}

/**
 * Reads a CSV as rows of text; empty cells are null and short rows are padded to the first row's
 * width. Encoding and delimiter are detected from the first 64 KB.
 */
export async function* parseCsv(
  stream: Readable,
  limits: ParseLimits
): AsyncGenerator<Row> {
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<
    Buffer | string
  >;
  const head: Buffer[] = [];
  let headBytes = 0;
  let ended = false;
  while (headBytes < SNIFF_BYTES) {
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      break;
    }
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(next.value);
    head.push(chunk);
    headBytes += chunk.length;
  }
  const headBuffer = Buffer.concat(head);
  const encoding = detectEncoding(headBuffer.subarray(0, SNIFF_BYTES));
  const decoder = new TextDecoder(encoding, { fatal: true });
  const sniffText = new TextDecoder(encoding).decode(
    headBuffer.subarray(0, SNIFF_BYTES),
    { stream: true }
  );
  const delimiter = detectDelimiter(sniffText);

  const text = Readable.from(
    (async function* () {
      try {
        yield decoder.decode(headBuffer, { stream: true });
        while (!ended) {
          const next = await iterator.next();
          if (next.done) break;
          yield decoder.decode(
            Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value),
            { stream: true }
          );
        }
        yield decoder.decode();
      } catch (err) {
        throw err instanceof TypeError ? decodeError() : err;
      }
    })(),
    { objectMode: false, encoding: "utf8" }
  );

  const parser = parse({
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
    info: true,
  });
  text.on("error", (err) => parser.destroy(err));
  text.pipe(parser);

  let width = 0;
  let dataRows = 0;
  try {
    for await (const item of parser as AsyncIterable<{
      record: string[];
      info: { records: number };
    }>) {
      const rowNumber = item.info.records;
      const record = item.record;
      if (rowNumber === 1) {
        width = record.length;
        if (width > limits.maxColumns) {
          throw new FileParseError(
            "too_many_columns",
            `The file has more than ${limits.maxColumns} columns.`
          );
        }
      } else {
        dataRows += 1;
        if (dataRows > limits.maxRows) {
          throw new FileParseError(
            "too_many_rows",
            `The file has more than ${limits.maxRows} rows.`,
            rowNumber
          );
        }
        if (record.length > width) {
          throw new FileParseError(
            "row_too_long",
            `Row ${rowNumber} has more cells than the header.`,
            rowNumber
          );
        }
      }
      // Postgres text cannot hold NUL. One in the sniffed head was refused
      // as binary; one further on is refused here, with its row.
      if (record.some((v) => v.includes("\0"))) {
        throw new FileParseError(
          "invalid_character",
          `Row ${rowNumber} holds a NUL character, which text cannot hold.`,
          rowNumber
        );
      }
      const row: Row = record.map((v) => (v === "" ? null : v));
      while (row.length < width) row.push(null);
      yield row;
    }
  } catch (err) {
    if (err instanceof FileParseError) throw err;
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && code.startsWith("CSV_")) {
      throw new FileParseError(
        "malformed_csv",
        (err as Error).message,
        (err as { lines?: number }).lines
      );
    }
    throw err;
  } finally {
    text.destroy();
    parser.destroy();
  }
}
