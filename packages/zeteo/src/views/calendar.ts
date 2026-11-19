import type { StoredCalendar } from "../calendar/service.js";

export const calendarView = ({ calendar, updatedAt }: StoredCalendar) => ({
  working_days: [...calendar.workingDays],
  holidays: [...calendar.holidays]
    .map(([date, name]) => ({ date, name }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  fiscal_year_start_month: calendar.fiscalYearStartMonth,
  time_zone: calendar.timeZone,
  updated_at: updatedAt ? updatedAt.toISOString() : null,
});

export type CalendarView = ReturnType<typeof calendarView>;
