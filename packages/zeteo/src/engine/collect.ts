import type { QueryResult, RowStream } from "../adapters/types.js";

/** The most rows asked for at a time. */
export const BATCH_ROWS = 250;
/**
 * About the most bytes one batch holds beyond the rows kept: each batch after
 * the first is sized from the average row read so far.
 */
export const BATCH_BYTES = 1024 * 1024;
/** The first batch, read before any row's width is known. */
const FIRST_BATCH_ROWS = 1;

/**
 * Reads `stream` until `maxRows` rows are kept and one more exists, the next
 * row would pass `maxBytes`, or it ends. A row's size is its JSON plus one
 * byte for the comma after it. The first batch is one row; each later one as
 * many rows of the average size so far as fit `BATCH_BYTES`, at least one
 * and at most `BATCH_ROWS`, so a result of wide rows is not buffered whole
 * before the byte cap applies; never more than one row past `maxRows` in
 * all. Does not close the stream.
 */
export const collect = async (
  stream: RowStream,
  limits: { maxRows: number; maxBytes: number }
): Promise<Pick<QueryResult, "rows" | "truncated">> => {
  const rows: unknown[][] = [];
  let fetched = 0;
  let bytes = 0;
  for (;;) {
    // Every row read so far is kept and counted in `bytes`: the read returns
    // at the first one it does not keep.
    const fits =
      rows.length === 0
        ? FIRST_BATCH_ROWS
        : Math.floor(BATCH_BYTES / (bytes / rows.length));
    const want = Math.min(
      Math.max(1, Math.min(BATCH_ROWS, fits)),
      limits.maxRows + 1 - fetched
    );
    const batch = await stream.next(want);
    if (batch.length === 0) return { rows, truncated: false };
    fetched += batch.length;
    for (const row of batch) {
      if (rows.length === limits.maxRows) return { rows, truncated: "rows" };
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > limits.maxBytes) return { rows, truncated: "bytes" };
      rows.push(row);
    }
  }
};
