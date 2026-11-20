import { DEFAULT_CALENDAR, type Calendar, type Weekday } from "./calendar.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { withAudit } from "../utils/transaction.js";
import { db } from "../utils/db/index.js";

export interface CalendarInput {
  working_days: Weekday[];
  holidays: { date: string; name: string }[];
  fiscal_year_start_month: number;
  time_zone: string;
}

/** A calendar as stored, with its change time; null `updatedAt` is the defaults. */
export interface StoredCalendar {
  calendar: Calendar;
  updatedAt: Date | null;
}

const RESOURCE_TYPE = "calendar";
/** The calendar has no id of its own: one per deployment. */
const RESOURCE_ID = "calendar";

const CACHE_TTL_MS = 30_000;

let cached: { at: number; value: StoredCalendar } | null = null;

/** Drops this process's cached calendar. `replaceCalendar` calls it; tests may too. */
export const clearCalendarCache = (): void => {
  cached = null;
};

const readStored = async (): Promise<StoredCalendar> => {
  const stored = await db.calendar.load();
  if (!stored) return { calendar: DEFAULT_CALENDAR, updatedAt: null };
  const { calendar, holidays } = stored;
  return {
    calendar: {
      workingDays: calendar.workingDays as Weekday[],
      holidays: new Map(
        holidays.map((h) => [h.date.toISOString().slice(0, 10), h.name])
      ),
      fiscalYearStartMonth: calendar.fiscalYearStartMonth,
      timeZone: calendar.timeZone,
    },
    updatedAt: calendar.updatedAt,
  };
};

/**
 * The calendar with its change time, cached in this process for 30 seconds. A
 * change made through another process shows here within that time.
 */
export const loadStoredCalendar = async (): Promise<StoredCalendar> => {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await readStored();
  cached = { at: Date.now(), value };
  return value;
};

export const loadCalendar = async (): Promise<Calendar> =>
  (await loadStoredCalendar()).calendar;

/** Replaces the whole calendar: the one row and every holiday. */
export const replaceCalendar = async (
  input: CalendarInput,
  actorId: string
): Promise<Calendar> => {
  const workingDays = [...new Set(input.working_days)].sort((a, b) => a - b);
  await withAudit(async (tx, audit) => {
    const data = {
      workingDays,
      fiscalYearStartMonth: input.fiscal_year_start_month,
      timeZone: input.time_zone,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    await tx.calendar.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });
    await tx.calendarHoliday.deleteMany();
    await tx.calendarHoliday.createMany({
      data: input.holidays.map((h) => ({
        date: new Date(`${h.date}T00:00:00.000Z`),
        name: h.name,
      })),
    });
    audit({
      action: AUDIT_EVENTS.calendarUpdated,
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      actorId,
      metadata: {
        working_days: workingDays,
        holiday_count: input.holidays.length,
        fiscal_year_start_month: input.fiscal_year_start_month,
        time_zone: input.time_zone,
      },
    });
  });
  clearCalendarCache();
  return loadCalendar();
};
