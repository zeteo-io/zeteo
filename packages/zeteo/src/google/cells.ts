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
// 0001-01-01 and 9999-12-31 as serials, and the instants bounding years 0001-9999.
const FIRST_SERIAL = -693593;
const LAST_SERIAL = 2958465;
const MIN_MS = -62_135_596_800_000;
const MAX_MS = 253_402_300_799_999;

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
  // `Date.UTC` reads years 0-99 as 1900-1999, so the year is set apart.
  const date = new Date(0);
  date.setUTCFullYear(get("year"), get("month") - 1, get("day"));
  date.setUTCHours(get("hour"), get("minute"), get("second"));
  const wall = date.getTime();
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
    if (type === "DATE" || type === "DATE_TIME") {
      // A serial outside years 0001-9999 (or not finite) is kept as its number, so no data is lost.
      if (!(n >= FIRST_SERIAL && n < LAST_SERIAL + 1)) return String(n);
      if (type === "DATE") {
        return new Date(EPOCH_MS + Math.floor(n) * DAY_MS)
          .toISOString()
          .slice(0, 10);
      }
      // Rounded to the millisecond. Unlike xlsx.ts, which cannot tell a date from a timestamp and
      // collapses midnight UTC to a date, Sheets names the type: a DATE_TIME stays a timestamp
      // even at midnight UTC.
      const instant = instantOf(EPOCH_MS + Math.round(n * DAY_MS), timeZone);
      // The zone's offset can push an edge serial just outside years 0001-9999.
      return instant >= MIN_MS && instant <= MAX_MS
        ? new Date(instant).toISOString()
        : String(n);
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
