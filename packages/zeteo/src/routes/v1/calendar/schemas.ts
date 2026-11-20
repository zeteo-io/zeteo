import { noNul } from "../../../utils/text.js";
import { z } from "zod";

/** Calendar days, "YYYY-MM-DD", that exist. */
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
    );
  }, "Not a calendar date");

/**
 * An IANA time zone name the runtime can format in. `Intl.supportedValuesOf`
 * lists ICU's canonical names only (`Asia/Calcutta`, not `Asia/Kolkata`), so a
 * name is checked by formatting with it instead. Offsets (`+05:00`) are not
 * names and are refused, and so is any name but `UTC` without a "/" (CET,
 * EST5EDT…), which Postgres may read as a fixed offset. The name is stored
 * as given.
 */
const isTimeZone = (zone: string): boolean => {
  if (!/^[A-Za-z]/.test(zone)) return false;
  // `UTC`, or a region name: Postgres reads some names without a "/" (CET,
  // EET, MET, WET, EST…) as fixed-offset abbreviations, with no summer time.
  if (zone !== "UTC" && !zone.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const MAX_HOLIDAYS = 5000;

export const PutCalendarSchema = z.strictObject({
  working_days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "Repeats a weekday"),
  holidays: z
    .array(
      z.strictObject({
        date: DateSchema,
        name: noNul(z.string().min(1).max(200)),
      })
    )
    .max(MAX_HOLIDAYS)
    .refine(
      (holidays) =>
        new Set(holidays.map((h) => h.date)).size === holidays.length,
      "Repeats a date"
    ),
  fiscal_year_start_month: z.number().int().min(1).max(12),
  time_zone: z
    .string()
    .max(100)
    .refine(
      isTimeZone,
      'Not a known IANA time zone: UTC or a region name such as "Europe/Paris"'
    ),
});
