/** ISO weekday, Monday = 1 … Sunday = 7. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Calendar {
  workingDays: readonly Weekday[];
  /** "YYYY-MM-DD" -> name */
  holidays: ReadonlyMap<string, string>;
  /** 1–12 */
  fiscalYearStartMonth: number;
  /** IANA time zone */
  timeZone: string;
}

export const DEFAULT_CALENDAR: Calendar = {
  workingDays: [1, 2, 3, 4, 5],
  holidays: new Map(),
  fiscalYearStartMonth: 1,
  timeZone: "UTC",
};

const DAY_MS = 86_400_000;

const parse = (date: string): { y: number; m: number; d: number } => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d };
};

/** `Date.UTC`, except that years 0–99 are those years, not 1900–1999. */
const utcMs = (
  y: number,
  month: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0
): number => {
  const date = new Date(Date.UTC(2000, month, d, h, mi, s));
  date.setUTCFullYear(y, month, d);
  return date.getTime();
};

const toMs = (date: string): number => {
  const { y, m, d } = parse(date);
  return utcMs(y, m - 1, d);
};

const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

const weekdayOf = (date: string): Weekday => {
  const day = new Date(toMs(date)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
};

export const isBusinessDay = (cal: Calendar, date: string): boolean =>
  cal.workingDays.includes(weekdayOf(date)) && !cal.holidays.has(date);

/**
 * Business days from `start` to `end`, both inclusive; 0 when `end < start`.
 * Counted by arithmetic, so a range of centuries costs no more than a week:
 * whole weeks times the working days in one, the leftover days one by one, and
 * the holidays that fall on working days inside the range taken off.
 */
export const businessDays = (
  cal: Calendar,
  start: string,
  end: string
): number => {
  const first = toMs(start);
  const last = toMs(end);
  if (last < first) return 0;
  const days = (last - first) / DAY_MS + 1;
  const working = new Set(cal.workingDays);
  const weeks = Math.floor(days / 7);
  let count = weeks * working.size;
  const firstWeekday = weekdayOf(start);
  for (let i = 0; i < days - weeks * 7; i += 1) {
    if (working.has((((firstWeekday - 1 + i) % 7) + 1) as Weekday)) count += 1;
  }
  for (const date of cal.holidays.keys()) {
    const ms = toMs(date);
    if (ms >= first && ms <= last && working.has(weekdayOf(date))) count -= 1;
  }
  return count;
};

const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

const monthEnd = (date: string): string => {
  const { y, m } = parse(date);
  return fromMs(utcMs(y, m, 0));
};

export const businessDaysInMonth = (cal: Calendar, date: string): number =>
  businessDays(cal, monthStart(date), monthEnd(date));

/** The 1st of the month through `date`, inclusive. */
export const businessDaysElapsed = (cal: Calendar, date: string): number =>
  businessDays(cal, monthStart(date), date);

/** The day after `date` through the end of the month. */
export const businessDaysRemaining = (cal: Calendar, date: string): number =>
  businessDays(cal, fromMs(toMs(date) + DAY_MS), monthEnd(date));

/** Months since the start of the fiscal year, 0–11. */
const monthsIntoFiscalYear = (cal: Calendar, date: string): number =>
  (parse(date).m - cal.fiscalYearStartMonth + 12) % 12;

export const fiscalPeriodStart = (
  cal: Calendar,
  date: string,
  unit: "fiscal_quarter" | "fiscal_year"
): string => {
  const { y, m } = parse(date);
  const into = monthsIntoFiscalYear(cal, date);
  const back = unit === "fiscal_year" ? into : into % 3;
  const index = y * 12 + (m - 1) - back;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}-01`;
};

/** A fiscal year is named by the calendar year it ends in. */
export const fiscalYearOf = (cal: Calendar, date: string): number => {
  const { y } = parse(date);
  return cal.fiscalYearStartMonth === 1 ||
    parse(date).m < cal.fiscalYearStartMonth
    ? y
    : y + 1;
};

export const fiscalQuarterOf = (cal: Calendar, date: string): number =>
  Math.floor(monthsIntoFiscalYear(cal, date) / 3) + 1;

const zonedParts = (instant: Date, timeZone: string): number[] => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return [
    get("year"),
    get("month"),
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  ];
};

/** The wall-clock date in `timeZone` at `instant`. */
export const localDate = (instant: Date, timeZone: string): string => {
  const [y, m, d] = zonedParts(instant, timeZone) as [number, number, number];
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
};

/** Local wall-clock time as if it were UTC, minus the instant: the zone's offset. */
const offsetAt = (instant: Date, timeZone: string): number => {
  const [y, mo, d, h, mi, s] = zonedParts(instant, timeZone) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    Date.UTC(y, mo - 1, d, h, mi, s) -
    Math.floor(instant.getTime() / 1000) * 1000
  );
};

/** The instant at which the wall clock in `timeZone` reads `wall` (as if UTC ms). */
export const zonedInstant = (wall: number, timeZone: string): Date => {
  let instant = new Date(wall - offsetAt(new Date(wall), timeZone));
  instant = new Date(wall - offsetAt(instant, timeZone));
  return instant;
};

const HOUR_MS = 3_600_000;

/**
 * The instant local midnight starts on `date` in `timeZone`; where a DST jump
 * skips midnight, the first instant of that local day.
 */
export const zonedMidnight = (date: string, timeZone: string): Date => {
  let instant = zonedInstant(toMs(date), timeZone);
  // Landed on the previous local day: midnight was skipped. Walk forward.
  while (localDate(instant, timeZone) < date) {
    instant = new Date(instant.getTime() + HOUR_MS);
  }
  return instant;
};
