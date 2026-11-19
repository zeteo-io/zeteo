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
  monthCounts,
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

  it("counts a multi-century range arithmetically", () => {
    expect(businessDays(DEFAULT_CALENDAR, "2000-01-01", "2099-12-31")).toBe(
      26089
    );
    expect(businessDays(DEFAULT_CALENDAR, "0001-01-01", "9999-12-31")).toBe(
      2_608_615
    );
  });

  it("counts holidays on working days only, inside the range only", () => {
    const cal = {
      ...DEFAULT_CALENDAR,
      holidays: new Map([
        ["2026-11-18", "Wednesday"],
        ["2026-11-21", "Saturday"],
        ["2026-12-25", "outside"],
      ]),
    };
    expect(businessDays(cal, "2026-11-16", "2026-11-22")).toBe(4);
  });

  it("is 0 when the end is before the start", () => {
    expect(businessDays(DEFAULT_CALENDAR, "2026-11-19", "2026-11-18")).toBe(0);
  });

  it("matches a day-by-day count on odd ranges and calendars", () => {
    const cal = {
      workingDays: [2, 4, 6, 7] as (1 | 2 | 3 | 4 | 5 | 6 | 7)[],
      holidays: new Map([
        ["2026-03-03", "x"],
        ["2026-03-07", "y"],
        ["2026-03-08", "z"],
        ["2026-03-09", "not a working day"],
      ]),
      fiscalYearStartMonth: 1,
      timeZone: "UTC",
    };
    for (const [a, b] of [
      ["2026-03-01", "2026-03-31"],
      ["2026-03-03", "2026-03-03"],
      ["2026-02-27", "2026-03-10"],
    ] as const) {
      let n = 0;
      for (let ms = Date.parse(a); ms <= Date.parse(b); ms += 86_400_000) {
        const d = new Date(ms).toISOString().slice(0, 10);
        if (isBusinessDay(cal, d)) n += 1;
      }
      expect(businessDays(cal, a, b)).toBe(n);
    }
  });
});

describe("monthCounts", () => {
  it("covers 25 years either side of now's month, in step with the days of each month", () => {
    const cal = withCal({
      holidays: new Map([["2026-11-26", "Thanksgiving"]]),
    });
    const { months, counts } = monthCounts(
      cal,
      new Date("2026-11-19T15:00:00Z")
    );
    expect(months).toHaveLength(601);
    expect(counts).toHaveLength(601);
    expect(months[0]).toBe("2001-11-01");
    expect(months[300]).toBe("2026-11-01");
    expect(months[600]).toBe("2051-11-01");
    expect(counts[300]).toBe(20);
    expect(
      counts.every((n, i) => n === businessDaysInMonth(cal, months[i]!))
    ).toBe(true);
  });

  it("takes now's month in the calendar's time zone", () => {
    const now = new Date("2026-11-30T23:30:00Z");
    expect(monthCounts(DEFAULT_CALENDAR, now).months[300]).toBe("2026-11-01");
    expect(
      monthCounts(withCal({ timeZone: "Pacific/Auckland" }), now).months[300]
    ).toBe("2026-12-01");
  });

  it("takes the window's width", () => {
    expect(
      monthCounts(DEFAULT_CALENDAR, new Date("2026-11-19T00:00:00Z"), 1).months
    ).toHaveLength(25);
  });
});
