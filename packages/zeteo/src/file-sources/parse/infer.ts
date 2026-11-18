import type { FileColumnType } from "../types.js";
import type { Row } from "./types.js";

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function validDate(y: string, m: string, d: string): boolean {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function kindOf(raw: string): FileColumnType {
  const v = raw.trim();
  if (NUMBER.test(v) && Number.isFinite(Number(v))) return "number";
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "false") return "boolean";
  const d = DATE.exec(v);
  if (d) return validDate(d[1]!, d[2]!, d[3]!) ? "date" : "text";
  const t = TIMESTAMP.exec(v);
  if (
    t &&
    validDate(t[1]!, t[2]!, t[3]!) &&
    Number(t[4]) < 24 &&
    Number(t[5]) < 60 &&
    Number(t[6] ?? 0) < 60
  ) {
    return "timestamp";
  }
  return "text";
}

/**
 * The narrowest type every non-empty value fits; text otherwise. Dates mixed with timestamps are
 * timestamps. No values at all is text.
 */
export function inferType(values: (string | null)[]): FileColumnType {
  let found: FileColumnType | null = null;
  for (const raw of values) {
    if (raw === null || raw.trim() === "") continue;
    const kind = kindOf(raw);
    if (kind === "text") return "text";
    if (found === null || found === kind) found = kind;
    else if (
      (found === "date" && kind === "timestamp") ||
      (found === "timestamp" && kind === "date")
    ) {
      found = "timestamp";
    } else return "text";
  }
  return found ?? "text";
}

/**
 * 0 (row 0 is the header) unless row 0 looks like data: some column where row 0's value has the
 * same non-text type as the values below it. Then null. Empty cells in row 0 don't count as data.
 */
export function detectHeaderRow(rows: Row[]): number | null {
  const first = rows[0];
  if (!first || first.length === 0) return null;
  const below = rows.slice(1);
  for (let c = 0; c < first.length; c += 1) {
    const cell = first[c];
    if (cell === null || cell === undefined || cell.trim() === "") continue;
    const kind = kindOf(cell);
    if (kind === "text") continue;
    const type = inferType([cell, ...below.map((r) => r[c] ?? null)]);
    if (
      type !== "text" &&
      below.some((r) => r[c] != null && r[c]!.trim() !== "")
    ) {
      return null;
    }
  }
  return 0;
}
