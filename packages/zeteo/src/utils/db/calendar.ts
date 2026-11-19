import { prisma } from "./prisma.js";
import type {
  Calendar,
  CalendarHoliday,
} from "../../../prisma/generated/client/index.js";

/** The stored calendar and its holidays; null when none was ever saved. */
export const load = async (): Promise<{
  calendar: Calendar;
  holidays: CalendarHoliday[];
} | null> => {
  const calendar = await prisma.calendar.findUnique({ where: { id: 1 } });
  if (!calendar) return null;
  const holidays = await prisma.calendarHoliday.findMany({
    orderBy: { date: "asc" },
  });
  return { calendar, holidays };
};
