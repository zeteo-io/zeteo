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

/** The day business-day arithmetic counts from, a Monday; earlier dates have no business days. */
export const BUSINESS_ANCHOR = "1900-01-01";
const ANCHOR_MS = Date.UTC(1900, 0, 1);
/**
 * The last date business-day functions take or give: a year short of the
 * engines' last, so a period's end is never past what they hold.
 */
export const LAST_BUSINESS_DATE = "9998-12-31";
/** Days from the anchor to `LAST_BUSINESS_DATE`. */
export const LAST_DAY_NUMBER = (Date.UTC(9998, 11, 31) - ANCHOR_MS) / DAY_MS;

/** Whether day `n` is one the business-day functions take: 1900-01-01 to 9998-12-31. */
const inRange = (n: number): boolean => n >= 0 && n <= LAST_DAY_NUMBER;
/** The largest step `addBusinessDays` takes; past it the result is null. */
export const MAX_BUSINESS_DAY_STEP = 3_000_000;

/** Days from the anchor (1900-01-01) to `date`; negative before it. */
export const dayNumber = (date: string): number =>
  Math.round((toMs(date) - ANCHOR_MS) / DAY_MS);

/** The date `n` days after the anchor. */
export const dateOfDayNumber = (n: number): string =>
  fromMs(ANCHOR_MS + n * DAY_MS);

const mod = (a: number, b: number): number => ((a % b) + b) % b;

/**
 * The calendar as the closed form reads it, counted from the anchor: working
 * weekdays as offsets (Monday 0 … Sunday 6), and the holidays that fall on
 * working weekdays as their ordinals among working weekdays (the first
 * working weekday from the anchor on is 1).
 */
export interface BusinessOrdinals {
  /** Working weekday offsets, ascending. */
  weekdays: number[];
  /** Per offset r, the working weekdays among offsets 0…r. */
  prefix: number[];
  /** Holidays on working weekdays from the anchor on, as working-weekday ordinals, ascending. */
  holidays: number[];
  /**
   * `holidays[i] - i`: the t-th business day comes after holiday i exactly
   * when its shift is at most t.
   */
  shifts: number[];
}

const ordinalsCache = new WeakMap<Calendar, BusinessOrdinals>();

/** Working weekdays from the anchor through day `n`. */
const weekdayOrdinal = (
  o: Pick<BusinessOrdinals, "weekdays" | "prefix">,
  n: number
): number => Math.floor(n / 7) * o.weekdays.length + o.prefix[mod(n, 7)]!;

export const businessOrdinals = (cal: Calendar): BusinessOrdinals => {
  const known = ordinalsCache.get(cal);
  if (known) return known;
  const weekdays = [...new Set(cal.workingDays)]
    .map((d) => d - 1)
    .sort((a, b) => a - b);
  const prefix: number[] = [];
  for (let r = 0; r < 7; r += 1) {
    prefix.push(weekdays.filter((w) => w <= r).length);
  }
  const holidays = [...cal.holidays.keys()]
    .map(dayNumber)
    .filter((n) => n >= 0 && weekdays.includes(mod(n, 7)))
    .sort((a, b) => a - b)
    .map((n) => weekdayOrdinal({ weekdays, prefix }, n));
  const ordinals: BusinessOrdinals = {
    weekdays,
    prefix,
    holidays,
    shifts: holidays.map((h, i) => h - i),
  };
  ordinalsCache.set(cal, ordinals);
  return ordinals;
};

/** How many of the ascending `values` are at most `x`. */
const countAtMost = (values: readonly number[], x: number): number => {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Business days from the anchor through day `n` (`n` at least -1). */
const businessOrdinal = (o: BusinessOrdinals, n: number): number => {
  const w = weekdayOrdinal(o, n);
  return w - countAtMost(o.holidays, w);
};

/**
 * Business days from `start` to `end`, both inclusive; 0 when `end < start`
 * (Excel's NETWORKDAYS). Counted by arithmetic, so a range of centuries costs
 * no more than a week. Null when either is outside 1900-01-01 to 9998-12-31,
 * as for every business-day function.
 */
export const businessDays = (
  cal: Calendar,
  start: string,
  end: string
): number | null => {
  const a = dayNumber(start);
  const b = dayNumber(end);
  if (!inRange(a) || !inRange(b)) return null;
  if (b < a) return 0;
  const o = businessOrdinals(cal);
  return businessOrdinal(o, b) - businessOrdinal(o, a - 1);
};

/**
 * Business days from `start` to `end` as a duration: `start` excluded, `end`
 * included, negative when `end < start`. Null when either is out of range.
 */
export const businessDaysBetween = (
  cal: Calendar,
  start: string,
  end: string
): number | null => {
  const a = dayNumber(start);
  const b = dayNumber(end);
  if (!inRange(a) || !inRange(b)) return null;
  const o = businessOrdinals(cal);
  return businessOrdinal(o, b) - businessOrdinal(o, a);
};

/** A period a business-day count spans, as a bucket's unit; a `day` is one day. */
export type BusinessUnit =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "fiscal_quarter"
  | "fiscal_year";

const monthIndexDate = (index: number): string =>
  `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}-01`;

const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/** The first day of the period of `unit` holding `date`; a week starts on Monday. */
export const periodStart = (
  cal: Calendar,
  unit: BusinessUnit,
  date: string
): string => {
  const { y, m } = parse(date);
  switch (unit) {
    case "day":
      return date;
    case "week":
      return dateOfDayNumber(dayNumber(date) - mod(dayNumber(date), 7));
    case "month":
      return monthStart(date);
    case "quarter":
      return monthIndexDate(y * 12 + (m - 1) - ((m - 1) % 3));
    case "year":
      return `${pad(y, 4)}-01-01`;
    default:
      return fiscalPeriodStart(cal, date, unit);
  }
};

/** The last day of the period of `unit` holding `date`. */
export const periodEnd = (
  cal: Calendar,
  unit: BusinessUnit,
  date: string
): string => {
  const start = periodStart(cal, unit, date);
  if (unit === "day") return start;
  if (unit === "week") return dateOfDayNumber(dayNumber(start) + 6);
  const { y, m } = parse(start);
  const months =
    unit === "month"
      ? 1
      : unit === "quarter" || unit === "fiscal_quarter"
        ? 3
        : 12;
  return dateOfDayNumber(
    dayNumber(monthIndexDate(y * 12 + m - 1 + months)) - 1
  );
};

/** Null when `date` is out of range or its period of `unit` starts before the anchor, else `count(o, start)`. */
const fromPeriodStart = (
  cal: Calendar,
  unit: BusinessUnit,
  date: string,
  count: (o: BusinessOrdinals, start: number) => number
): number | null => {
  if (!inRange(dayNumber(date))) return null;
  const start = dayNumber(periodStart(cal, unit, date));
  return start < 0 ? null : count(businessOrdinals(cal), start);
};

/** The business days of the period of `unit` holding `date`; null when it starts before the anchor. */
export const businessDaysIn = (
  cal: Calendar,
  unit: BusinessUnit,
  date: string
): number | null =>
  fromPeriodStart(
    cal,
    unit,
    date,
    (o, start) =>
      businessOrdinal(o, dayNumber(periodEnd(cal, unit, date))) -
      businessOrdinal(o, start - 1)
  );

export const businessDaysInMonth = (
  cal: Calendar,
  date: string
): number | null => businessDaysIn(cal, "month", date);

/** The period's first day through `date`, inclusive; null when the period starts before the anchor. */
export const businessDaysElapsed = (
  cal: Calendar,
  date: string,
  unit: BusinessUnit = "month"
): number | null =>
  fromPeriodStart(
    cal,
    unit,
    date,
    (o, start) =>
      businessOrdinal(o, dayNumber(date)) - businessOrdinal(o, start - 1)
  );

/** The day after `date` through the period's last day; null when the period starts before the anchor. */
export const businessDaysRemaining = (
  cal: Calendar,
  date: string,
  unit: BusinessUnit = "month"
): number | null =>
  fromPeriodStart(
    cal,
    unit,
    date,
    (o) =>
      businessOrdinal(o, dayNumber(periodEnd(cal, unit, date))) -
      businessOrdinal(o, dayNumber(date))
  );

/** Which business day of its month `date` is (`datePart` `business_day`): 0 before the month's first. */
export const businessDayOfMonth = (
  cal: Calendar,
  date: string
): number | null => businessDaysElapsed(cal, date, "month");

/**
 * The date `n` business days after `date` (before it when `n` is negative),
 * `n` truncated toward zero, the days counted from `date` itself (Excel's
 * WORKDAY): Saturday + 1 is Monday and Saturday - 1 is Friday; `n = 0` gives
 * `date` itself when it is a business day, else the next one. Null when `date` or the result is outside
 * 1900-01-01 to 9998-12-31, or `n` is more than 3,000,000 either way.
 */
export const addBusinessDays = (
  cal: Calendar,
  date: string,
  n: number
): string | null => {
  const d = dayNumber(date);
  if (!inRange(d) || !(Math.abs(n) <= MAX_BUSINESS_DAY_STEP)) return null;
  const k = Math.trunc(n);
  const o = businessOrdinals(cal);
  const w = weekdayOrdinal(o, d);
  const below = countAtMost(o.holidays, w);
  const working = o.weekdays.includes(mod(d, 7));
  const holiday = below - countAtMost(o.holidays, w - 1) > 0;
  const t = w - below + k + (k <= 0 && !(working && !holiday) ? 1 : 0);
  if (t < 1) return null;
  // The working-weekday ordinal of the t-th business day, then its date.
  const x = t + countAtMost(o.shifts, t);
  const W = o.weekdays.length;
  const result = Math.floor((x - 1) / W) * 7 + o.weekdays[(x - 1) % W]!;
  return result > LAST_DAY_NUMBER ? null : dateOfDayNumber(result);
};

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

/** Years either side of now's year that a zone's offsets are known for in a query. */
export const ZONE_WINDOW_YEARS = 25;

/** One UTC offset in effect from `s` (inclusive) to `e` (exclusive), both naive UTC `YYYY-MM-DDTHH:MM:SS`. */
export interface ZoneSpan {
  s: string;
  e: string;
  /** Seconds east of UTC. */
  o: number;
}

/**
 * The offsets of a time zone over a window of years, so an engine without the
 * zone's rules (SQL Server knows only Windows names) reads an instant's local
 * date the same as one with them. Outside `[from, to)` a local date is unknown.
 */
export interface ZoneWindow {
  /** The IANA name. */
  name: string;
  /** ISO 8601 instants with `Z`. */
  from: string;
  to: string;
  /** Consecutive, covering the window. */
  spans: ZoneSpan[];
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Seconds east of UTC in `timeZone` at `ms` (whole seconds). */
const offsetSeconds = (ms: number, timeZone: string): number => {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const wall = utcMs(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 1000);
};

const naive = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

const windows = new Map<string, ZoneWindow | null>();

/**
 * `timeZone`'s offsets from January 1st 25 years before `now`'s year to
 * January 1st 26 years after it, in UTC; undefined when the offset is 0
 * throughout (UTC needs no conversion). Cached per zone and year.
 */
export const zoneWindow = (
  timeZone: string,
  now: Date
): ZoneWindow | undefined => {
  const year = now.getUTCFullYear();
  const key = `${timeZone}\u0000${year}`;
  const known = windows.get(key);
  if (known !== undefined) return known ?? undefined;
  const from = utcMs(year - ZONE_WINDOW_YEARS, 0, 1);
  const to = utcMs(year + ZONE_WINDOW_YEARS + 1, 0, 1);
  const spans: ZoneSpan[] = [];
  let start = from;
  let offset = offsetSeconds(from, timeZone);
  // A day at a time: zones change offset at most a few times a year. Each
  // change is then found to the second between the two days.
  for (let day = from; day < to; day += DAY_MS) {
    const next = Math.min(day + DAY_MS, to);
    const after = offsetSeconds(next, timeZone);
    if (after === offset || next === to) continue;
    let lo = day;
    let hi = next;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (offsetSeconds(mid, timeZone) === offset) lo = mid;
      else hi = mid;
    }
    spans.push({ s: naive(start), e: naive(hi), o: offset });
    start = hi;
    offset = after;
  }
  spans.push({ s: naive(start), e: naive(to), o: offset });
  const window = spans.every((span) => span.o === 0)
    ? null
    : {
        name: timeZone,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        spans,
      };
  windows.set(key, window);
  return window ?? undefined;
};

/** The local date of `instant` in a zone's window, or null outside it (UTC has no window). */
export const windowedLocalDate = (
  instant: Date,
  timeZone: string,
  window: ZoneWindow | undefined
): string | null => {
  if (
    window &&
    (instant.getTime() < Date.parse(window.from) ||
      instant.getTime() >= Date.parse(window.to))
  ) {
    return null;
  }
  return localDate(instant, timeZone);
};

/**
 * The calendar as a query's plan carries it: what the closed form binds into
 * the SQL. Every number comes from the calendar, never from a query.
 */
export interface CompiledCalendar {
  /** Working weekday offsets, Monday 0 … Sunday 6, ascending; one to seven. */
  weekdays: number[];
  /** `BusinessOrdinals.holidays`. */
  holidays: number[];
  /** `BusinessOrdinals.shifts`. */
  shifts: number[];
  /** The zone a timestamp's date is read in; absent when it is UTC throughout. */
  zone?: ZoneWindow;
}

const compiledCache = new WeakMap<Calendar, Map<number, CompiledCalendar>>();

/** `cal` for a plan made at `now`; one object per calendar and year, so plans share it. */
export const compiledCalendar = (
  cal: Calendar,
  now: Date
): CompiledCalendar => {
  let byYear = compiledCache.get(cal);
  if (!byYear) {
    byYear = new Map();
    compiledCache.set(cal, byYear);
  }
  const year = now.getUTCFullYear();
  const known = byYear.get(year);
  if (known) return known;
  const { weekdays, holidays, shifts } = businessOrdinals(cal);
  const zone = zoneWindow(cal.timeZone, now);
  const compiled: CompiledCalendar = {
    weekdays,
    holidays,
    shifts,
    ...(zone ? { zone } : {}),
  };
  byYear.set(year, compiled);
  return compiled;
};
