// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { fetchJson } from "../../../support/http.js";
import {
  calendarWriteToken,
  resetCalendar,
  validCalendar,
} from "../../../support/calendar.js";

describe("PUT /v1/calendar validation", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;

  const put = (body: unknown) =>
    fetchJson("PUT", `${app.url}/v1/calendar`, calendarWriteToken(), body);

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await resetCalendar();
    await app.close();
  });

  const many = Array.from({ length: 5001 }, (_, i) => ({
    date: new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10),
    name: "Day",
  }));

  it.each([
    ["empty working_days", { working_days: [] }],
    ["a weekday of 0", { working_days: [0, 1] }],
    ["a weekday of 8", { working_days: [1, 8] }],
    ["a repeated weekday", { working_days: [1, 1] }],
    [
      "duplicate holiday dates",
      {
        holidays: [
          { date: "2026-12-25", name: "A" },
          { date: "2026-12-25", name: "B" },
        ],
      },
    ],
    ["more than 5,000 holidays", { holidays: many }],
    ["an invalid date", { holidays: [{ date: "2026-02-30", name: "A" }] }],
    ["a malformed date", { holidays: [{ date: "25/12/2026", name: "A" }] }],
    ["an empty holiday name", { holidays: [{ date: "2026-12-25", name: "" }] }],
    ["month 0", { fiscal_year_start_month: 0 }],
    ["month 13", { fiscal_year_start_month: 13 }],
    ["an unknown time zone", { time_zone: "Mars/Olympus" }],
    ["an unknown field", { extra: true }],
  ])("refuses %s with invalid_request and issues", async (_name, change) => {
    const res = await put(validCalendar(change));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("accepts UTC and 5,000 holidays", async () => {
    const res = await put(
      validCalendar({ time_zone: "UTC", holidays: many.slice(0, 5000) })
    );
    expect(res.status).toBe(200);
  });
});
