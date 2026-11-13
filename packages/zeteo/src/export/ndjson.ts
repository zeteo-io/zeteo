import type { ExportSink } from "../engine/export.js";

type Head = Parameters<ExportSink["start"]>[0];
type Tail = Parameters<ExportSink["end"]>[0];

/** The first line: the columns, the query's warnings and the run's id. */
export const ndjsonHead = (head: Head): string =>
  JSON.stringify({
    columns: head.columns.map(({ name, type }) => ({ name, type })),
    warnings: head.warnings,
    run_id: head.runId,
  }) + "\n";

/** One row: a JSON array of its values in their wire forms. */
export const ndjsonRow = (row: unknown[]): string => JSON.stringify(row) + "\n";

/** The last line: how the export ended, and how many rows it sent. */
export const ndjsonTail = (tail: Tail): string =>
  JSON.stringify({ status: tail.status, rows: tail.rows }) + "\n";
