/** The part of the Sheets API's `CellData` that `cellText` reads. */
export type SheetCell = {
  effectiveValue?: {
    numberValue?: number;
    stringValue?: string;
    boolValue?: boolean;
    errorValue?: { type: string; message?: string };
  };
  effectiveFormat?: { numberFormat?: { type: string } };
};

const DAY_MS = 86_400_000;
// Sheets serial numbers count days from 1899-12-30.
const EPOCH_MS = Date.UTC(1899, 11, 30);

/** How far `timeZone` is ahead of UTC at the instant `utcMs`, in ms. Throws a RangeError for an unknown zone. */
function offsetAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which a clock in `timeZone` shows the wall time `wallMs` (read as if UTC).
 * Like JS Temporal's "compatible": a repeated wall time (DST end) takes the earlier instant, one
 * that does not exist (DST gap) is read with the offset from before the gap, so 02:30 becomes 03:30.
 */
function instantOf(wallMs: number, timeZone: string): number {
  const before = offsetAt(wallMs - DAY_MS, timeZone);
  const after = offsetAt(wallMs + DAY_MS, timeZone);
  const candidates = [before, after]
    .map((offset) => ({ offset, at: wallMs - offset }))
    .filter(({ offset, at }) => offsetAt(at, timeZone) === offset)
    .map(({ at }) => at);
  return candidates.length > 0 ? Math.min(...candidates) : wallMs - before;
}

function render(cell: SheetCell | undefined, timeZone: string): string | null {
  const value = cell?.effectiveValue;
  if (!value) return null;
  if (value.stringValue !== undefined) {
    return value.stringValue === "" ? null : value.stringValue;
  }
  if (value.boolValue !== undefined) return value.boolValue ? "true" : "false";
  if (value.numberValue !== undefined) {
    const n = value.numberValue;
    const type = cell?.effectiveFormat?.numberFormat?.type;
    // A serial outside what a Date holds is kept as its number, so no data is lost.
    if (type === "DATE") {
      const date = new Date(EPOCH_MS + Math.floor(n) * DAY_MS);
      return Number.isNaN(date.getTime())
        ? String(n)
        : date.toISOString().slice(0, 10);
    }
    if (type === "DATE_TIME") {
      const wall = EPOCH_MS + Math.round(n * DAY_MS);
      if (Number.isNaN(new Date(wall).getTime())) return String(n);
      const instant = new Date(instantOf(wall, timeZone));
      // Unlike xlsx.ts, which cannot tell a date from a timestamp and collapses midnight UTC to a
      // date, Sheets names the type: a DATE_TIME stays a timestamp even at midnight UTC.
      return Number.isNaN(instant.getTime())
        ? String(n)
        : instant.toISOString();
    }
    return String(n);
  }
  return null;
}

/**
 * A cell as text, the way `uploads/parse/xlsx.ts` renders a workbook cell: text as is, booleans
 * `true`/`false`, a DATE `YYYY-MM-DD`, a DATE_TIME its full ISO 8601 UTC instant (the serial is
 * wall time in the spreadsheet's `timeZone`; an unknown zone throws a RangeError), any other number
 * `String(n)`; an error, an empty cell and no cell are null. Formulas arrive as their value.
 */
export function cellText(
  cell: SheetCell | undefined,
  timeZone: string
): string | null {
  return render(cell, timeZone);
}
