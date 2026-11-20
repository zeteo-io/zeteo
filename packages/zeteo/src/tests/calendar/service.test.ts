// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { resetCalendar } from "../support/calendar.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  clearCalendarCache,
  loadCalendar,
  replaceCalendar,
} from "../../calendar/service.js";

const input = (overrides = {}) => ({
  working_days: [1, 2, 3, 4, 5, 6] as (1 | 2 | 3 | 4 | 5 | 6 | 7)[],
  holidays: [{ date: "2026-12-25", name: "Christmas Day" }],
  fiscal_year_start_month: 10,
  time_zone: "America/Chicago",
  ...overrides,
});

describe("the calendar service", () => {
  beforeAll(initializeTereo);
  beforeEach(async () => {
    await resetCalendar();
    clearCalendarCache();
  });
  afterAll(async () => {
    await resetCalendar();
    await stopTereo();
  });

  it("loads the defaults when no calendar is stored", async () => {
    const cal = await loadCalendar();
    expect(cal.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(cal.holidays.size).toBe(0);
    expect(cal.fiscalYearStartMonth).toBe(1);
    expect(cal.timeZone).toBe("UTC");
  });

  it("loads what replaceCalendar stored, as a Calendar", async () => {
    await replaceCalendar(input(), randomUUID());
    clearCalendarCache();
    const cal = await loadCalendar();
    expect(cal.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...cal.holidays]).toEqual([["2026-12-25", "Christmas Day"]]);
    expect(cal.fiscalYearStartMonth).toBe(10);
    expect(cal.timeZone).toBe("America/Chicago");
  });

  it("serves a cached calendar until replaceCalendar clears it", async () => {
    const first = await loadCalendar();
    // A change made behind the service's back is not seen while cached.
    await prisma.calendar.create({
      data: {
        id: 1,
        workingDays: [1],
        fiscalYearStartMonth: 2,
        timeZone: "UTC",
      },
    });
    expect(await loadCalendar()).toBe(first);
    await replaceCalendar(input(), randomUUID());
    expect((await loadCalendar()).fiscalYearStartMonth).toBe(10);
  });

  it("keeps one row and replaces every holiday", async () => {
    const actor = randomUUID();
    await replaceCalendar(input(), actor);
    await replaceCalendar(
      input({ holidays: [{ date: "2027-01-01", name: "New Year" }] }),
      actor
    );
    expect(await prisma.calendar.count()).toBe(1);
    expect(
      (await prisma.calendar.findUnique({ where: { id: 1 } }))?.updatedBy
    ).toBe(actor);
    const days = await prisma.calendarHoliday.findMany();
    expect(days.map((d) => d.date.toISOString().slice(0, 10))).toEqual([
      "2027-01-01",
    ]);
  });

  it("is refused by the database for a second row or a month of 13", async () => {
    const row = {
      workingDays: [1],
      fiscalYearStartMonth: 1,
      timeZone: "UTC",
    };
    await expect(
      prisma.calendar.create({ data: { id: 2, ...row } })
    ).rejects.toThrow();
    await expect(
      prisma.calendar.create({
        data: { id: 1, ...row, fiscalYearStartMonth: 13 },
      })
    ).rejects.toThrow();
  });
});
