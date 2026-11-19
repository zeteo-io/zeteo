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

const toMs = (date: string): number => {
  const { y, m, d } = parse(date);
  return Date.UTC(y, m - 1, d);
};

const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

const weekdayOf = (date: string): Weekday => {
  const day = new Date(toMs(date)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
};

export const isBusinessDay = (cal: Calendar, date: string): boolean =>
  cal.workingDays.includes(weekdayOf(date)) && !cal.holidays.has(date);

/** Business days from `start` to `end`, both inclusive; 0 when `end < start`. */
export const businessDays = (
  cal: Calendar,
  start: string,
  end: string
): number => {
  const last = toMs(end);
  let count = 0;
  for (let ms = toMs(start); ms <= last; ms += DAY_MS) {
    if (isBusinessDay(cal, fromMs(ms))) count += 1;
  }
  return count;
};

const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

const monthEnd = (date: string): string => {
  const { y, m } = parse(date);
  return fromMs(Date.UTC(y, m, 0));
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

/** The instant local midnight starts on `date` in `timeZone`. */
export const zonedMidnight = (date: string, timeZone: string): Date => {
  const wall = toMs(date);
  let instant = new Date(wall - offsetAt(new Date(wall), timeZone));
  instant = new Date(wall - offsetAt(instant, timeZone));
  return instant;
};
