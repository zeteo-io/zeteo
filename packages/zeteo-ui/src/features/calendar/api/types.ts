// Field for field the server's `calendarView`.

export interface Holiday {
  date: string;
  name: string;
}

/** `working_days` are ISO weekdays: 1 Monday to 7 Sunday. */
export interface Calendar {
  working_days: number[];
  holidays: Holiday[];
  fiscal_year_start_month: number;
  time_zone: string;
  updated_at: string | null;
}

/** What `PUT /v1/calendar` takes: the whole calendar. */
export type CalendarBody = Omit<Calendar, "updated_at">;
