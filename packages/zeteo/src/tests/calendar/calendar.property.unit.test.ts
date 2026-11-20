// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addBusinessDays,
  businessDayOfMonth,
  businessDays,
  businessDaysBetween,
  businessDaysElapsed,
  businessDaysIn,
  businessDaysRemaining,
  isBusinessDay,
  periodEnd,
  periodStart,
  type BusinessUnit,
  type Calendar,
  type Weekday,
} from "../../calendar/calendar.js";

// The calendar's closed-form business-day functions, which the planner folds
// constants with and the int suites hold both engines to, against a count
// made a day at a time over random calendars and dates.

const NUM_RUNS = 300;
/** Reproduce a failure with `FC_SEED=<seed>`. */
const SEED = Number(process.env.FC_SEED ?? 20261120);
const DAY = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);
const ANCHOR = ms("1900-01-01");

/** Dates from 1900-01-01 into 1903, near the anchor, and around 2026. */
const dateArb = fc.oneof(
  fc.integer({ min: 0, max: 1200 }).map((n) => iso(ANCHOR + n * DAY)),
  fc.integer({ min: 0, max: 2000 }).map((n) => iso(ms("2024-06-01") + n * DAY))
);

const calendarArb: fc.Arbitrary<Calendar> = fc
  .record({
    workingDays: fc.uniqueArray(fc.integer({ min: 1, max: 7 }), {
      minLength: 1,
      maxLength: 7,
    }),
    holidays: fc.uniqueArray(dateArb, { maxLength: 40 }),
    fiscalYearStartMonth: fc.integer({ min: 1, max: 12 }),
  })
  .map(({ workingDays, holidays, fiscalYearStartMonth }) => ({
    workingDays: workingDays as Weekday[],
    holidays: new Map(holidays.map((h) => [h, "h"])),
    fiscalYearStartMonth,
    timeZone: "UTC",
  }));

/** Business days in [a, b] counted one day at a time. */
const naiveCount = (cal: Calendar, a: string, b: string): number => {
  let n = 0;
  for (let t = ms(a); t <= ms(b); t += DAY) {
    if (isBusinessDay(cal, iso(t))) n += 1;
  }
  return n;
};

/** The n-th business day after (or before) `date`, walked a day at a time. */
const naiveAdd = (cal: Calendar, date: string, n: number): string | null => {
  let t = ms(date);
  if (n === 0) {
    while (!isBusinessDay(cal, iso(t))) t += DAY;
    return iso(t);
  }
  const step = n > 0 ? DAY : -DAY;
  let left = Math.abs(n);
  while (left > 0) {
    t += step;
    if (t < ANCHOR) return null;
    if (isBusinessDay(cal, iso(t))) left -= 1;
  }
  return iso(t);
};

const UNITS: BusinessUnit[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_quarter",
  "fiscal_year",
];

const params = { numRuns: NUM_RUNS, seed: SEED };

describe("business days, against a day-by-day count", () => {
  it("counts businessDays both ends inclusive, 0 when the end is first", () => {
    fc.assert(
      fc.property(calendarArb, dateArb, dateArb, (cal, a, b) => {
        expect(businessDays(cal, a, b)).toBe(b < a ? 0 : naiveCount(cal, a, b));
      }),
      params
    );
  });

  it("counts businessDaysBetween with the start excluded, negative backwards", () => {
    fc.assert(
      fc.property(calendarArb, dateArb, dateArb, (cal, a, b) => {
        const expected =
          a === b
            ? 0
            : a < b
              ? naiveCount(cal, iso(ms(a) + DAY), b)
              : 0 - naiveCount(cal, iso(ms(b) + DAY), a);
        expect(businessDaysBetween(cal, a, b)).toBe(expected);
      }),
      params
    );
  });

  it("splits each period into its days through a date and after it", () => {
    fc.assert(
      fc.property(
        calendarArb,
        dateArb,
        fc.constantFrom(...UNITS),
        (cal, d, unit) => {
          const start = periodStart(cal, unit, d);
          const end = periodEnd(cal, unit, d);
          expect(start <= d && d <= end).toBe(true);
          if (start < "1900-01-01") {
            expect(businessDaysIn(cal, unit, d)).toBe(null);
            return;
          }
          expect(businessDaysIn(cal, unit, d)).toBe(
            naiveCount(cal, start, end)
          );
          expect(businessDaysElapsed(cal, d, unit)).toBe(
            naiveCount(cal, start, d)
          );
          expect(businessDaysRemaining(cal, d, unit)).toBe(
            d === end ? 0 : naiveCount(cal, iso(ms(d) + DAY), end)
          );
        }
      ),
      params
    );
  });

  it("reads business_day as the month's business days through the date", () => {
    fc.assert(
      fc.property(calendarArb, dateArb, (cal, d) => {
        expect(businessDayOfMonth(cal, d)).toBe(
          naiveCount(cal, `${d.slice(0, 7)}-01`, d)
        );
      }),
      params
    );
  });

  it("adds business days as a walk from the date itself, the next business day for none", () => {
    fc.assert(
      fc.property(
        calendarArb,
        dateArb,
        fc.integer({ min: -40, max: 40 }),
        (cal, d, n) => {
          expect(addBusinessDays(cal, d, n)).toBe(naiveAdd(cal, d, n));
        }
      ),
      params
    );
  });

  it("truncates a fractional step toward zero", () => {
    fc.assert(
      fc.property(
        calendarArb,
        dateArb,
        fc.double({ min: -30, max: 30, noNaN: true }),
        (cal, d, n) => {
          expect(addBusinessDays(cal, d, n)).toBe(
            addBusinessDays(cal, d, Math.trunc(n))
          );
        }
      ),
      params
    );
  });
});
