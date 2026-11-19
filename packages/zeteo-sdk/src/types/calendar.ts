export interface Holiday {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 1 to 200 characters. */
  name: string;
}

/**
 * The whole calendar, as `calendar.replace` takes it. Defaults until one is
 * saved: Monday to Friday, no holidays, January and `UTC`.
 */
export interface CalendarInput {
  /** 1 (Monday) to 7 (Sunday), each once; at least one. */
  working_days: number[];
  /** Unique by date, at most 5,000. A holiday on a non-working day has no effect. */
  holidays: Holiday[];
  /** 1 to 12. */
  fiscal_year_start_month: number;
  /** An IANA time zone name, or `UTC`. */
  time_zone: string;
}

export interface Calendar extends CalendarInput {
  /** Null until a calendar has been saved. */
  updated_at: string | null;
}
