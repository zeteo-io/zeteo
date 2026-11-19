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

const TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

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
    .refine((zone) => TIME_ZONES.has(zone), "Not a known IANA time zone"),
});
