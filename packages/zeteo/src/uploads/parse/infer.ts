import type { UploadColumnType } from "../types.js";
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

function kindOf(raw: string): UploadColumnType {
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
 * Infers a column's type one value at a time, so a file need not be held in memory. `type` is the
 * narrowest type every non-empty value added so far fits; text otherwise. Dates mixed with
 * timestamps are timestamps. No values at all is text.
 */
export class TypeInferrer {
  private found: UploadColumnType | null = null;
  private isText = false;

  add(raw: string | null | undefined): void {
    if (this.isText || raw === null || raw === undefined || raw.trim() === "") {
      return;
    }
    const kind = kindOf(raw);
    if (kind === "text") this.isText = true;
    else if (this.found === null || this.found === kind) this.found = kind;
    else if (
      (this.found === "date" && kind === "timestamp") ||
      (this.found === "timestamp" && kind === "date")
    ) {
      this.found = "timestamp";
    } else this.isText = true;
  }

  get type(): UploadColumnType {
    return this.isText ? "text" : (this.found ?? "text");
  }
}

/** The narrowest type every non-empty value fits; text otherwise (see `TypeInferrer`). */
export function inferType(values: (string | null)[]): UploadColumnType {
  const inferrer = new TypeInferrer();
  for (const raw of values) inferrer.add(raw);
  return inferrer.type;
}

const BANNER_ROWS = 3;

function filled(row: Row | undefined): string[] {
  return (row ?? []).filter(
    (c): c is string => c !== null && c !== undefined && c.trim() !== ""
  );
}

/**
 * The header row: among the first three rows, the first label row (two or more non-empty cells,
 * all text) whose rows above are all sparse (fewer non-empty cells than half of its own: a banner)
 * and under which some cell is not text. 0 for a first row of text otherwise, and null when row 0
 * looks like data: some column where row 0's value has the same non-text type as the values below
 * it. Empty cells don't count as data.
 */
export function detectHeaderRow(rows: Row[]): number | null {
  const first = rows[0];
  if (!first || first.length === 0) return null;
  const window = Math.min(rows.length, BANNER_ROWS);
  const isLabelRow = (r: Row | undefined) => {
    const cells = filled(r);
    return cells.length >= 2 && cells.every((c) => kindOf(c) === "text");
  };
  for (let k = 0; k < window; k += 1) {
    const labels = filled(rows[k]);
    if (!isLabelRow(rows[k])) continue;
    // A later, denser label row makes this one a banner.
    if (
      rows
        .slice(k + 1, window)
        .some((r) => isLabelRow(r) && labels.length * 2 < filled(r).length)
    ) {
      continue;
    }
    if (!rows.slice(0, k).every((r) => filled(r).length * 2 < labels.length)) {
      continue;
    }
    const evidence = rows
      .slice(k + 1)
      .some((r) => filled(r).some((c) => kindOf(c) !== "text"));
    if (evidence) return k;
  }
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
