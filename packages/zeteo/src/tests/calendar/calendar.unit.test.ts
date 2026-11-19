// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  businessDays,
  businessDaysElapsed,
  businessDaysInMonth,
  businessDaysRemaining,
  DEFAULT_CALENDAR,
  fiscalPeriodStart,
  fiscalQuarterOf,
  fiscalYearOf,
  isBusinessDay,
  localDate,
  zonedMidnight,
  type Calendar,
} from "../../calendar/calendar.js";

const withCal = (over: Partial<Calendar>): Calendar => ({
  ...DEFAULT_CALENDAR,
  ...over,
});

describe("calendar", () => {
  it("counts business days in a month", () => {
    expect(businessDaysInMonth(DEFAULT_CALENDAR, "2026-02-10")).toBe(20);
    expect(businessDaysInMonth(DEFAULT_CALENDAR, "2028-02-01")).toBe(21);
    expect(businessDaysInMonth(DEFAULT_CALENDAR, "2026-03-31")).toBe(22);
  });

  it("subtracts weekday holidays only", () => {
    const cal = withCal({
      holidays: new Map([
        ["2026-05-25", "Memorial Day"],
        ["2026-05-23", "Sat holiday"],
      ]),
    });
    expect(businessDaysInMonth(cal, "2026-05-01")).toBe(20);
  });

  it("splits a month into elapsed and remaining", () => {
    expect(businessDaysElapsed(DEFAULT_CALENDAR, "2026-11-18")).toBe(13);
    expect(businessDaysRemaining(DEFAULT_CALENDAR, "2026-11-18")).toBe(8);
    for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 864e5) {
      const date = new Date(d).toISOString().slice(0, 10);
      expect(
        businessDaysElapsed(DEFAULT_CALENDAR, date) +
          businessDaysRemaining(DEFAULT_CALENDAR, date)
      ).toBe(businessDaysInMonth(DEFAULT_CALENDAR, date));
    }
  });

  it("counts a range inclusively", () => {
    expect(businessDays(DEFAULT_CALENDAR, "2026-11-20", "2026-11-19")).toBe(0);
    expect(businessDays(DEFAULT_CALENDAR, "2026-01-01", "2026-12-31")).toBe(
      261
    );
  });

  it("honours custom working days", () => {
    const cal = withCal({ workingDays: [7, 1, 2, 3, 4] });
    expect(isBusinessDay(cal, "2026-11-22")).toBe(true);
  });

  it("finds fiscal periods", () => {
    const cal = withCal({ fiscalYearStartMonth: 2 });
    expect(fiscalPeriodStart(cal, "2026-01-15", "fiscal_year")).toBe(
      "2025-02-01"
    );
    expect(fiscalYearOf(cal, "2026-01-15")).toBe(2026);
    expect(fiscalYearOf(cal, "2026-02-01")).toBe(2027);
    expect(fiscalPeriodStart(cal, "2026-04-30", "fiscal_quarter")).toBe(
      "2026-02-01"
    );
    expect(fiscalQuarterOf(cal, "2026-05-01")).toBe(2);
    expect(fiscalYearOf(DEFAULT_CALENDAR, "2026-06-01")).toBe(2026);
  });

  it("converts between instants and local dates", () => {
    expect(localDate(new Date("2026-11-19T03:00:00Z"), "America/Chicago")).toBe(
      "2026-11-18"
    );
    expect(zonedMidnight("2026-03-08", "America/Chicago").toISOString()).toBe(
      "2026-03-08T06:00:00.000Z"
    );
    expect(zonedMidnight("2026-03-09", "America/Chicago").toISOString()).toBe(
      "2026-03-09T05:00:00.000Z"
    );
  });

  it("returns the first instant of the day where DST skips midnight", () => {
    expect(zonedMidnight("2026-09-06", "America/Santiago").toISOString()).toBe(
      "2026-09-06T04:00:00.000Z"
    );
    expect(zonedMidnight("2026-03-08", "America/Havana").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z"
    );
  });
});
