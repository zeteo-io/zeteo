import { CALENDAR_WRITE } from "../../definitions/tereoDeclaration.js";
import { clearCalendarCache } from "../../calendar/service.js";
import { prisma } from "../../utils/db/prisma.js";
import { BASE_URL, fetchJson } from "./http.js";
import { tokenFor } from "./tokens.js";

export const calendarWriteToken = () =>
  tokenFor({ permissions: [CALENDAR_WRITE] });

export const validCalendar = (overrides: Record<string, unknown> = {}) => ({
  working_days: [1, 2, 3, 4, 5],
  holidays: [{ date: "2026-12-25", name: "Christmas Day" }],
  fiscal_year_start_month: 4,
  time_zone: "Europe/Paris",
  ...overrides,
});

/**
 * Back to the defaults. The shared server keeps what it read for 30 seconds
 * and only its own PUT clears that, so the defaults go in through the API
 * first; then the row and the audit entries are deleted, so "no row" holds.
 */
export const resetCalendar = async (): Promise<void> => {
  const res = await fetchJson(
    "PUT",
    `${BASE_URL}/v1/calendar`,
    calendarWriteToken(),
    {
      working_days: [1, 2, 3, 4, 5],
      holidays: [],
      fiscal_year_start_month: 1,
      time_zone: "UTC",
    }
  );
  if (res.status !== 200) throw new Error(`calendar not reset: ${res.status}`);
  await prisma.calendarHoliday.deleteMany();
  await prisma.calendar.deleteMany();
  await prisma.$executeRaw`
    DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = 'calendar'`;
  clearCalendarCache();
};
