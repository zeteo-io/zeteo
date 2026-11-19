import { z } from "zod";
import {
  DEFAULT_CALENDAR,
  fiscalPeriodStart,
  localDate,
  zonedInstant,
  zonedMidnight,
  type Calendar,
} from "../../calendar/calendar.js";

export const RELATIVE_UNITS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_quarter",
  "fiscal_year",
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

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * `r` resolved against `now`: shifted by `offset` units, then cut back to the
 * start of the unit when `startOf` is set. Minutes and hours shift the instant;
 * every larger unit works on the wall clock in `calendar.timeZone` and returns
 * the instant that local moment starts (or the shifted local moment). A week
 * starts on Monday; fiscal units follow `calendar.fiscalYearStartMonth`.
 */
export const resolveRelative = (
  r: RelativeDate,
  now: Date,
  calendar: Calendar = DEFAULT_CALENDAR
): Date => {
  const { unit, offset, startOf } = r.relative;
  if (unit === "minute" || unit === "hour") {
    const step = unit === "minute" ? MINUTE_MS : 60 * MINUTE_MS;
    const d = new Date(now.getTime() + offset * step);
    return startOf ? new Date(Math.floor(d.getTime() / step) * step) : d;
  }
  const tz = calendar.timeZone;
  // The wall clock now, as if it were UTC.
  const wallNow = Date.parse(
    `${localDate(now, tz)}T${new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(now)}.${String(now.getUTCMilliseconds()).padStart(3, "0")}Z`
  );
  let wall: Date;
  switch (unit) {
    case "day":
      wall = new Date(wallNow + offset * DAY_MS);
      break;
    case "week":
      wall = new Date(wallNow + offset * 7 * DAY_MS);
      break;
    case "month":
      wall = addMonths(new Date(wallNow), offset);
      break;
    case "quarter":
    case "fiscal_quarter":
      wall = addMonths(new Date(wallNow), offset * 3);
      break;
    case "year":
    case "fiscal_year":
      wall = addMonths(new Date(wallNow), offset * 12);
      break;
  }
  if (!startOf) return zonedInstant(wall.getTime(), tz);
  const date = wall.toISOString().slice(0, 10);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const pad = (n: number): string => String(n).padStart(2, "0");
  switch (unit) {
    case "day":
      return zonedMidnight(date, tz);
    case "week": {
      const sinceMonday = (wall.getUTCDay() + 6) % 7;
      return zonedMidnight(
        new Date(Date.UTC(y, m, wall.getUTCDate() - sinceMonday))
          .toISOString()
          .slice(0, 10),
        tz
      );
    }
    case "month":
      return zonedMidnight(`${date.slice(0, 7)}-01`, tz);
    case "quarter":
      return zonedMidnight(`${y}-${pad(m - (m % 3) + 1)}-01`, tz);
    case "year":
      return zonedMidnight(`${y}-01-01`, tz);
    case "fiscal_quarter":
    case "fiscal_year":
      return zonedMidnight(fiscalPeriodStart(calendar, date, unit), tz);
  }
};

/** `r` as the local `YYYY-MM-DD` in `calendar.timeZone`, for date columns. */
export const resolveRelativeDate = (
  r: RelativeDate,
  now: Date,
  calendar: Calendar = DEFAULT_CALENDAR
): string => localDate(resolveRelative(r, now, calendar), calendar.timeZone);
