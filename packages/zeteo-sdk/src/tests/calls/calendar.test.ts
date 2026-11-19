import type { Calendar, CalendarInput } from "../../types/calendar.js";
import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";

const input: CalendarInput = {
  working_days: [1, 2, 3, 4, 5],
  holidays: [{ date: "2026-12-25", name: "Christmas Day" }],
  fiscal_year_start_month: 7,
  time_zone: "America/Chicago",
};
const calendar: Calendar = { ...input, updated_at: "2026-11-19T10:00:00.000Z" };

describe("calendar", () => {
  const t = useStubbedClient();

  it("get sends GET /v1/calendar", async () => {
    t.stub.respond(() => ({ body: calendar }));
    expect(await t.client.calendar.get()).toEqual(calendar);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/calendar",
    });
  });

  it("replace sends PUT /v1/calendar with the whole calendar", async () => {
    t.stub.respond(() => ({ body: calendar }));
    expect(await t.client.calendar.replace(input)).toEqual(calendar);
    expect(t.stub.requests[0]).toMatchObject({
      method: "PUT",
      path: "/v1/calendar",
      body: input,
    });
  });
});
