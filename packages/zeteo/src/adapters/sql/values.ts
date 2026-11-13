/**
 * How a result value travels: 64-bit integers and decimals as strings, so no
 * digit is lost; other numbers as JSON numbers; dates as `YYYY-MM-DD`;
 * timestamps as ISO 8601 UTC with exactly milliseconds.
 */
export type WireKind =
  | "int64"
  | "decimal"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "json"
  | "text";

// Postgres's ISO output with any offset (`+02`, `-03:30`, `+05:53:28`), years
// 0001 to 9999 AD.
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/;

/** The float values JSON has no number for. */
const NOT_FINITE = new Set(["NaN", "Infinity", "-Infinity"]);

/**
 * A timestamp in the database's ISO text form as ISO 8601 UTC. A value
 * without an offset is taken as UTC. Digits past the millisecond are cut, not
 * rounded, so a value never moves into the next second, day or bucket.
 * Anything else (`infinity`, `-infinity`, BC, years past 9999) is returned as
 * the database printed it.
 */
const toIsoUtc = (text: string): string => {
  const m = TIMESTAMP.exec(text);
  if (!m) return text;
  const [, y, mo, d, h, mi, s, fraction, sign, oh, om, os] = m;
  const offsetSeconds =
    sign === undefined
      ? 0
      : (sign === "-" ? -1 : 1) *
        (Number(oh) * 3600 + Number(om ?? 0) * 60 + Number(os ?? 0));
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, keeps years 0 to 99 as they are.
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(
    Number(h),
    Number(mi),
    Number(s) - offsetSeconds,
    Number((fraction ?? "").padEnd(3, "0").slice(0, 3))
  );
  return date.toISOString();
};

/** A value as the database printed it in text, in its wire form. */
export const normaliseValue = (
  value: string | null,
  wire: WireKind
): unknown => {
  if (value === null) return null;
  switch (wire) {
    case "number":
      return NOT_FINITE.has(value) ? value : Number(value);
    case "boolean":
      return value === "t";
    case "timestamp":
      return toIsoUtc(value);
    case "json":
      return JSON.parse(value);
    case "int64":
    case "decimal":
    case "date":
    case "text":
      return value;
  }
};
