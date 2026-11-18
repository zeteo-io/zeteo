import { detectHeaderRow, TypeInferrer } from "./parse/infer.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import { emptyColumnsWarning } from "./warnings.js";
import type { UploadColumnType } from "./types.js";
import { normalizeName } from "./parse/names.js";
import { withXlsxSlot } from "./uploadLimits.js";
import { checkZipBounds } from "./zipGuard.js";
import { parseXlsx } from "./parse/xlsx.js";
import { logger } from "../utils/logger.js";
import { parseCsv } from "./parse/csv.js";
import { Readable } from "node:stream";
import env from "../env.js";
import {
  EmptyFileError,
  FileTooLargeError,
  FileUnreadableError,
  SheetInUseError,
  StagingNotFoundError,
  TooManyRequestsError,
  UnsupportedFileTypeError,
} from "../utils/errors.js";
import {
  FileParseError,
  type ParsedSheet,
  type ParseLimits,
  type Row,
} from "./parse/types.js";
import {
  appendStagingRows,
  createStagingTable,
  dropStagingTable,
  listStagingTables,
  stagingCreatedAt,
} from "./storage.js";

/**
 * Staging: an upload parsed once, its raw cells (header row included) kept as
 * text in staging tables, and a preview for its owner to confirm or change.
 * Nothing here reaches an upload source; Task 6's confirm loads a staging.
 *
 * Nothing holds the whole file: a CSV streams through the parser into the
 * staging table in batches; only an xlsx is buffered (the workbook reader
 * needs it all): its compressed bytes are counted against `UPLOAD_MAX_BYTES`
 * as they arrive, and it is checked before reading (`checkZipBounds`, on the entries JSZip
 * itself finds: declared and actual inflated size within twice the limit), and read while
 * fewer than `UPLOAD_XLSX_CONCURRENCY` other workbooks are (`withXlsxSlot`).
 * A table's types come from per-column state kept while its rows go by.
 */

/** A staging lives one hour. */
export const STAGING_TTL_MS = 60 * 60_000;
/** Rows per insert. */
const BATCH_ROWS = 2000;
/** Rows the header check looks at, and the preview's samples come from. */
const HEAD_ROWS = 1000;
/** Sample values kept per column. */
export const SAMPLES_PER_COLUMN = 10;
/** Bytes read to tell the file's type. */
const SNIFF_BYTES = 8 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Starts of common binary formats; a file beginning so is not text. */
const BINARY_MAGICS = [
  Buffer.from("%PDF"),
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from("GIF8"),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  Buffer.from("Rar!"),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf]),
];

export interface PreviewColumn {
  index: number;
  name: string;
  original_name: string;
  type: UploadColumnType;
  samples: string[];
}

export interface PreviewTable {
  /** Names the table within the staging: `csv`, `sheet:<name>` or `table:<name>`. */
  key: string;
  name: string;
  kind: "csv" | "sheet" | "table";
  /** The 0-based row holding the header, null when the first row looks like data. */
  header_row: number | null;
  /** Data rows, the header not counted. */
  row_count: number;
  columns: PreviewColumn[];
  warnings: string[];
}

/** What a staging table holds, kept in `UploadStaging.tables`; its rows include the header. */
export interface StagedTable {
  key: string;
  stagingTable: string;
  /** Rows in the staging table, the header row included. */
  rowCount: number;
  columnCount: number;
  /** Where a Google Sheets tab lives in its spreadsheet; absent for a file's tables. */
  locator?: { sheetId: number };
}

export interface StagingResult {
  stagingId: string;
  expiresAt: Date;
  tables: PreviewTable[];
}

/** The staging row of `id` for its owner; expired, someone else's and missing all answer `StagingNotFoundError`. */
export const getStaging = async (
  id: string,
  callerId: string,
  now: Date = new Date()
) => {
  const row = await prisma.uploadStaging.findFirst({
    where: { id, ownerId: callerId, expiresAt: { gt: now } },
  });
  if (!row) throw new StagingNotFoundError();
  return {
    ...row,
    preview: row.preview as unknown as PreviewTable[],
    tables: row.tables as unknown as StagedTable[],
  };
};

/**
 * Deletes stagings past `expires_at` and drops their tables. Returns how many
 * it deleted.
 */
export const deleteExpiredStagings = async (
  now: Date = new Date()
): Promise<number> => {
  let deleted = 0;
  for (;;) {
    const rows = await prisma.uploadStaging.findMany({
      where: { expiresAt: { lte: now } },
      take: 100,
      orderBy: { expiresAt: "asc" },
    });
    if (rows.length === 0) return deleted;
    for (const row of rows) {
      for (const table of row.tables as unknown as StagedTable[]) {
        await dropStagingTable(table.stagingTable);
      }
      await prisma.uploadStaging.deleteMany({ where: { id: row.id } });
      deleted += 1;
    }
  }
};

/**
 * Refuses, with 429 `too_many_stagings`, a user who already holds
 * `UPLOAD_MAX_STAGINGS` unexpired stagings; `retry_after` is when the
 * oldest expires. Checked before an upload is read, and again, under a lock
 * per owner, as its staging row is recorded.
 */
export const checkStagingRoom = async (
  ownerId: string,
  now: Date = new Date(),
  db: Prisma.TransactionClient = prisma
): Promise<void> => {
  const max = env.UPLOAD_MAX_STAGINGS;
  const held = await db.uploadStaging.findMany({
    where: { ownerId, expiresAt: { gt: now } },
    select: { expiresAt: true },
    orderBy: { expiresAt: "asc" },
  });
  if (held.length < max) return;
  const retryAfter = Math.max(
    1,
    Math.ceil((held[0]!.expiresAt.getTime() - now.getTime()) / 1000)
  );
  throw new TooManyRequestsError(
    retryAfter,
    `You have ${held.length} uploads not yet confirmed, the most allowed; confirm one or wait for it to expire`,
    "too_many_stagings"
  );
};

const startsWith = (head: Buffer, magic: Buffer) =>
  head.length >= magic.length && head.subarray(0, magic.length).equals(magic);

const hasUtf16Bom = (head: Buffer) =>
  (head[0] === 0xff && head[1] === 0xfe) ||
  (head[0] === 0xfe && head[1] === 0xff);

type FileType = "xlsx" | "csv";

/**
 * The file's type from its content, never its name: a ZIP is an xlsx (the
 * reader says if it is not one); a known binary format, or any NUL byte
 * outside a UTF-16 file, is refused as `unsupported_file_type`; everything
 * else is CSV text, whose encoding the CSV reader judges (an undecodable text
 * file is `unsupported_encoding`, not a wrong type).
 */
export const sniffFileType = (head: Buffer): FileType => {
  if (startsWith(head, ZIP_MAGIC)) return "xlsx";
  if (BINARY_MAGICS.some((m) => startsWith(head, m))) {
    throw new UnsupportedFileTypeError();
  }
  if (!hasUtf16Bom(head) && head.includes(0)) {
    throw new UnsupportedFileTypeError();
  }
  return "csv";
};

/**
 * The upload's bytes as a stream that fails with `FileTooLargeError` once
 * more than `maxBytes` have gone by; `head` is what was already read.
 */
const counted = (
  head: Buffer[],
  rest: AsyncIterator<Buffer | string>,
  maxBytes: number
): Readable => {
  let total = 0;
  const check = (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBytes) throw new FileTooLargeError(maxBytes);
    return chunk;
  };
  return Readable.from(
    (async function* () {
      for (const chunk of head) yield check(chunk);
      for (;;) {
        const next = await rest.next();
        if (next.done) return;
        yield check(
          Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
        );
      }
    })(),
    { objectMode: false }
  );
};

/** Reads chunks until `SNIFF_BYTES` or the end. */
const peek = async (iterator: AsyncIterator<Buffer | string>) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (bytes < SNIFF_BYTES) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(next.value);
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return { chunks, head: Buffer.concat(chunks) };
};

/** A parse failure as the 422 the caller gets; anything else as it is. */
export const toUnreadable = (err: unknown): unknown =>
  err instanceof FileParseError
    ? new FileUnreadableError(err.code, err.message, err.row)
    : err;

/** What `stageTable` needs to know of a table besides its rows. */
export interface StageMeta {
  key: string;
  fallbackName: string;
  kind: PreviewTable["kind"];
  /**
   * Keep only the columns up to the last that holds a value, and nothing for a
   * table of empty cells: a Google Sheets tab arrives as wide as its grid.
   * A file's tables are as wide as their data already.
   */
  trimUnusedColumns?: boolean;
}

/**
 * A table's rows into a new staging table (all of them, the header row
 * included) while keeping what the preview needs. Returns null for a table
 * with no rows or no columns.
 */
export const stageTable = async (
  rows: AsyncIterable<Row> | Row[],
  meta: StageMeta,
  takenTableNames: Set<string>,
  created: string[]
): Promise<{ preview: PreviewTable; staged: StagedTable } | null> => {
  const head: Row[] = [];
  let stagingTable: string | null = null;
  let width = 0;
  let total = 0;
  let batch: Row[] = [];
  // With `trimUnusedColumns`: the columns up to the last that holds a value.
  let used = 0;
  // Types over every row, and over the rows below each possible header row (0, 1 or 2).
  let all: TypeInferrer[] = [];
  let after: TypeInferrer[][] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await appendStagingRows(stagingTable!, batch);
    batch = [];
  };

  for await (const row of rows) {
    if (stagingTable === null) {
      width = row.length;
      if (width === 0) continue;
      stagingTable = await createStagingTable(width);
      created.push(stagingTable);
      all = Array.from({ length: width }, () => new TypeInferrer());
      after = Array.from({ length: 3 }, () =>
        Array.from({ length: width }, () => new TypeInferrer())
      );
    }
    const padded =
      row.length === width
        ? row
        : [
            ...row.slice(0, width),
            ...Array(Math.max(0, width - row.length)).fill(null),
          ];
    if (meta.trimUnusedColumns) {
      for (let c = width - 1; c >= used; c--) {
        const v = padded[c];
        if (v !== null && v !== undefined && v !== "") {
          used = c + 1;
          break;
        }
      }
    }
    for (let c = 0; c < width; c++) {
      all[c]!.add(padded[c]);
      for (let k = 0; k < after.length; k++) {
        if (total > k) after[k]![c]!.add(padded[c]);
      }
    }
    if (head.length < HEAD_ROWS) head.push(padded);
    batch.push(padded);
    total += 1;
    if (batch.length >= BATCH_ROWS) await flush();
  }
  if (stagingTable === null || total === 0) return null;
  if (meta.trimUnusedColumns && used === 0) {
    // Nothing but empty cells: no table.
    await dropStagingTable(stagingTable);
    created.splice(created.indexOf(stagingTable), 1);
    return null;
  }
  await flush();
  if (meta.trimUnusedColumns) {
    width = used;
    for (let i = 0; i < head.length; i++) head[i] = head[i]!.slice(0, used);
  }

  const headerRow = detectHeaderRow(head);
  const warnings: string[] = [];
  if (headerRow === null) {
    warnings.push("The first row looks like data, so the file has no header.");
  }
  const dataFrom = headerRow === null ? 0 : headerRow + 1;
  const taken = new Set<string>();
  const columns: PreviewColumn[] = Array.from({ length: width }, (_, index) => {
    const raw = headerRow === null ? "" : (head[headerRow]![index] ?? "");
    const name = normalizeName(raw, taken, index);
    const samples: string[] = [];
    for (const row of head.slice(dataFrom)) {
      const value = row[index];
      if (value !== null && value !== undefined && value !== "") {
        samples.push(value);
        if (samples.length === SAMPLES_PER_COLUMN) break;
      }
    }
    const type = (headerRow === null ? all : after[headerRow]!)[index]!.type;
    return {
      index,
      name,
      original_name: headerRow === null ? name : raw,
      type,
      samples,
    };
  });
  const empty = emptyColumnsWarning(
    total > dataFrom
      ? columns.filter((c) => c.samples.length === 0).map((c) => c.name)
      : []
  );
  if (empty) warnings.push(empty);

  const name = normalizeName(meta.fallbackName, takenTableNames, 0);
  return {
    preview: {
      key: meta.key,
      name,
      kind: meta.kind,
      header_row: headerRow,
      row_count: total - dataFrom,
      columns,
      warnings,
    },
    staged: {
      key: meta.key,
      stagingTable,
      rowCount: total,
      columnCount: width,
    },
  };
};

const stem = (filename: string) =>
  filename.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || "data";

/**
 * Stages an uploaded file for `ownerId`: reads it as a stream (CSV) or
 * buffered within the byte limit (xlsx), stages every table's raw rows,
 * and records a `UploadStaging` row with the preview. On any failure the staging
 * tables made so far are dropped and no row is kept.
 */
export const stageUpload = async ({
  ownerId,
  filename,
  stream,
  now = new Date(),
}: {
  ownerId: string;
  filename: string;
  stream: Readable;
  now?: Date;
}): Promise<StagingResult> => {
  const maxBytes = env.UPLOAD_MAX_BYTES;
  const limits: ParseLimits = {
    maxRows: env.UPLOAD_MAX_ROWS,
    maxColumns: env.UPLOAD_MAX_COLUMNS,
  };
  const created: string[] = [];
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<
    Buffer | string
  >;
  try {
    const { chunks, head } = await peek(iterator);
    if (head.length === 0) throw new EmptyFileError();
    const type = sniffFileType(head);
    const bytes = counted(chunks, iterator, maxBytes);

    const tables: { preview: PreviewTable; staged: StagedTable }[] = [];
    const taken = new Set<string>();
    try {
      if (type === "csv") {
        const result = await stageTable(
          parseCsv(bytes, limits),
          { key: "csv", fallbackName: stem(filename), kind: "csv" },
          taken,
          created
        );
        if (result) tables.push(result);
      } else {
        const parts: Buffer[] = [];
        for await (const chunk of bytes) parts.push(chunk as Buffer);
        const workbook = Buffer.concat(parts);
        // The workbook is read whole into memory: a few at a time per process.
        await withXlsxSlot(async () => {
          await checkZipBounds(workbook, 2 * maxBytes, maxBytes);
          const sheets = await parseXlsx(workbook, limits);
          for (const sheet of sheets) {
            const result = await stageTable(
              sheet.rows,
              {
                key: `${sheet.kind}:${sheet.name}`,
                fallbackName: sheet.name,
                kind: sheet.kind,
              },
              taken,
              created
            );
            if (result) tables.push(result);
          }
        });
      }
    } catch (err) {
      throw toUnreadable(err);
    }
    if (tables.length === 0) throw new EmptyFileError();

    return await recordStaging({
      ownerId,
      kind: type === "csv" ? "csv" : "xlsx",
      tables,
      now,
    });
  } catch (err) {
    await dropStagingTables(created);
    // Stop reading the upload; this destroys the stream.
    await iterator.return?.().catch(() => undefined);
    throw err;
  }
};

/** Drops staging tables no staging row will name; a failed drop is logged, not thrown. */
export const dropStagingTables = async (created: string[]): Promise<void> => {
  for (const table of created) {
    await dropStagingTable(table).catch((dropErr: unknown) => {
      logger.error({ err: dropErr, table }, "dropping a staging table failed");
    });
  }
};

/**
 * Records a staging row for staged tables. Stagings of one owner are
 * recorded one at a time, each counting the others first.
 */
const recordStaging = async ({
  ownerId,
  kind,
  vendorFileId,
  tables,
  now,
}: {
  ownerId: string;
  kind: "csv" | "xlsx" | "google-sheets";
  vendorFileId?: string;
  tables: { preview: PreviewTable; staged: StagedTable }[];
  now: Date;
}): Promise<StagingResult> => {
  const preview = tables.map((t) => t.preview);
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zeteo:upload-stagings:${ownerId}`}, 0))`;
    await checkStagingRoom(ownerId, new Date(), tx);
    return tx.uploadStaging.create({
      data: {
        ownerId,
        kind,
        vendorFileId,
        preview: preview as unknown as object,
        tables: tables.map((t) => t.staged) as unknown as object,
        expiresAt: new Date(now.getTime() + STAGING_TTL_MS),
      },
    });
  });
  return { stagingId: row.id, expiresAt: row.expiresAt, tables: preview };
};

/**
 * Stages the tabs of an already-read spreadsheet for `ownerId` like an
 * upload's tables, keyed `sheet:<sheetId>`, and records the staging with the
 * spreadsheet's id. On any failure the staging tables made so far are dropped.
 */
export const stageSheets = async ({
  ownerId,
  spreadsheet,
  now = new Date(),
}: {
  ownerId: string;
  spreadsheet: {
    id: string;
    title: string;
    tabs: (ParsedSheet & { sheetId: number })[];
  };
  now?: Date;
}): Promise<StagingResult> => {
  const created: string[] = [];
  try {
    const tables: { preview: PreviewTable; staged: StagedTable }[] = [];
    const taken = new Set<string>();
    for (const tab of spreadsheet.tabs) {
      const result = await stageTable(
        tab.rows,
        {
          key: `sheet:${tab.sheetId}`,
          fallbackName: tab.name,
          kind: "sheet",
          trimUnusedColumns: true,
        },
        taken,
        created
      );
      if (result) {
        result.staged.locator = { sheetId: tab.sheetId };
        tables.push(result);
      }
    }
    if (tables.length === 0) throw new EmptyFileError();
    return await recordStaging({
      ownerId,
      kind: "google-sheets",
      vendorFileId: spreadsheet.id,
      tables,
      now,
    });
  } catch (err) {
    await dropStagingTables(created);
    throw err;
  }
};

/**
 * Throws `SheetInUseError` when an unarchived source already reads this
 * spreadsheet; never says whose it is. A friendly pre-check, not a guard: two
 * callers can both pass it, and the partial unique index `sources_vendor_file_key`
 * is what stops the second source at create time.
 */
export const assertSheetUnclaimed = async (
  spreadsheetId: string,
  db: Prisma.TransactionClient = prisma
): Promise<void> => {
  const claimed = await db.source.findFirst({
    where: {
      type: "google_sheets",
      vendorFileId: spreadsheetId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (claimed) throw new SheetInUseError();
};

/**
 * Discards the caller's own staging: drops its tables and deletes its row,
 * which frees its place under `UPLOAD_MAX_STAGINGS`. Expired, someone
 * else's and missing all answer `StagingNotFoundError`.
 */
export const discardOwnStaging = async (
  id: string,
  callerId: string
): Promise<void> => {
  await getStaging(id, callerId);
  await discardStaging(id);
};

/** Deletes a staging row and drops its tables; a staging already gone is fine. */
export const discardStaging = async (id: string): Promise<void> => {
  const row = await prisma.uploadStaging.findUnique({ where: { id } });
  if (!row) return;
  for (const table of row.tables as unknown as StagedTable[]) {
    await dropStagingTable(table.stagingTable);
  }
  await prisma.uploadStaging.deleteMany({ where: { id } });
};

/**
 * Drops staging tables no `UploadStaging` row names that are older than the
 * staging lifetime: what an upload leaves when its process dies between
 * creating a table and recording the row. A table's age is in its name
 * (`stagingCreatedAt`). Returns how many it dropped.
 */
export const deleteOrphanStagingTables = async (
  now: Date = new Date()
): Promise<number> => {
  const cutoff = now.getTime() - STAGING_TTL_MS;
  let dropped = 0;
  for (const name of await listStagingTables()) {
    if (stagingCreatedAt(name).getTime() > cutoff) continue;
    const named = await prisma.uploadStaging.findFirst({
      where: { tables: { array_contains: [{ stagingTable: name }] } },
      select: { id: true },
    });
    if (named) continue;
    await dropStagingTable(name);
    dropped += 1;
  }
  return dropped;
};
