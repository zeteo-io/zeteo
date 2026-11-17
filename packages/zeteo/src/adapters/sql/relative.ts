import { z } from "zod";

export const RELATIVE_UNITS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export type RelativeUnit = (typeof RELATIVE_UNITS)[number];

export const MAX_RELATIVE_OFFSET = 1000;

/** A moment as an offset from now: `{ relative: { unit: "day", offset: -30 } }`. */
export const relativeDateSchema = z.strictObject({
  relative: z.strictObject({
    unit: z.enum(RELATIVE_UNITS),
    offset: z.int().min(-MAX_RELATIVE_OFFSET).max(MAX_RELATIVE_OFFSET),
    startOf: z.boolean().optional(),
  }),
});

export type RelativeDate = z.infer<typeof relativeDateSchema>;

export const isRelativeDate = (value: unknown): value is RelativeDate =>
  typeof value === "object" && value !== null && "relative" in value;

/** `d` with its seconds and milliseconds dropped. */
export const floorToMinute = (d: Date): Date =>
  new Date(Math.floor(d.getTime() / 60_000) * 60_000);

const MINUTE_MS = 60_000;

/** Adds whole months in UTC, clamping the day to the target month's last. */
const addMonths = (d: Date, months: number): Date => {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(d.getTime());
  out.setUTCFullYear(year, month, Math.min(d.getUTCDate(), lastDay));
  return out;
};

/**
 * `r` resolved against `now`, in UTC: shifted by `offset` units, then cut back
 * to the start of the unit when `startOf` is set. A week starts on Monday.
 */
export const resolveRelative = (r: RelativeDate, now: Date): Date => {
  const { unit, offset, startOf } = r.relative;
  let d: Date;
  switch (unit) {
    case "minute":
      d = new Date(now.getTime() + offset * MINUTE_MS);
      break;
    case "hour":
      d = new Date(now.getTime() + offset * 60 * MINUTE_MS);
      break;
    case "day":
      d = new Date(now.getTime() + offset * 24 * 60 * MINUTE_MS);
      break;
    case "week":
      d = new Date(now.getTime() + offset * 7 * 24 * 60 * MINUTE_MS);
      break;
    case "month":
      d = addMonths(now, offset);
      break;
    case "quarter":
      d = addMonths(now, offset * 3);
      break;
    case "year":
      d = addMonths(now, offset * 12);
      break;
  }
  if (!startOf) return d;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (unit) {
    case "minute":
      return floorToMinute(d);
    case "hour":
      return new Date(
        Math.floor(d.getTime() / (60 * MINUTE_MS)) * 60 * MINUTE_MS
      );
    case "day":
      return new Date(Date.UTC(y, m, d.getUTCDate()));
    case "week": {
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, d.getUTCDate() - sinceMonday));
    }
    case "month":
      return new Date(Date.UTC(y, m, 1));
    case "quarter":
      return new Date(Date.UTC(y, m - (m % 3), 1));
    case "year":
      return new Date(Date.UTC(y, 0, 1));
  }
};
