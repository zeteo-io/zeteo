import { CALENDAR_WRITE } from "../../definitions/tereoDeclaration.js";
import { prisma } from "../../utils/db/prisma.js";
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

/** Removes the stored calendar and the audit entries about it: back to the defaults. */
export const resetCalendar = async (): Promise<void> => {
  await prisma.calendarHoliday.deleteMany();
  await prisma.calendar.deleteMany();
  await prisma.$executeRaw`
    DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = 'calendar'`;
};
