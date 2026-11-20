import { prisma } from "./prisma.js";
import type {
  Calendar,
  CalendarHoliday,
} from "../../../prisma/generated/client/index.js";

/** The stored calendar and its holidays; null when none was ever saved. */
export const load = (): Promise<{
  calendar: Calendar;
  holidays: CalendarHoliday[];
} | null> =>
  // One snapshot, so a read cannot pair a new row with the old holidays.
  prisma.$transaction(
    async (tx) => {
      const calendar = await tx.calendar.findUnique({ where: { id: 1 } });
      if (!calendar) return null;
      const holidays = await tx.calendarHoliday.findMany({
        orderBy: { date: "asc" },
      });
      return { calendar, holidays };
    },
    { isolationLevel: "RepeatableRead" }
  );
