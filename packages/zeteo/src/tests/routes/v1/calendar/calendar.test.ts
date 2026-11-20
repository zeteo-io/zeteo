// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newQueryUser } from "../../../support/queries.js";
import { startV1Routes } from "../../../support/v1App.js";
import { fetchJson } from "../../../support/http.js";
import {
  calendarWriteToken,
  resetCalendar,
  validCalendar,
} from "../../../support/calendar.js";

describe("/v1/calendar", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const user = newQueryUser();

  const get = () => fetchJson("GET", `${app.url}/v1/calendar`, user.token);
  const put = (body: unknown) =>
    fetchJson("PUT", `${app.url}/v1/calendar`, calendarWriteToken(), body);

  beforeAll(async () => {
    app = await startV1Routes();
  });
  beforeEach(async () => {
    await resetCalendar();
    // The server in this process kept what it read last.
    const { clearCalendarCache } =
      await import("../../../../calendar/service.js");
    clearCalendarCache();
  });
  afterAll(async () => {
    await resetCalendar();
    await app.close();
  });

  it("returns the defaults when none was saved", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      working_days: [1, 2, 3, 4, 5],
      holidays: [],
      fiscal_year_start_month: 1,
      time_zone: "UTC",
      updated_at: null,
    });
  });

  it("returns what a PUT saved, holidays sorted by date", async () => {
    const saved = await put(
      validCalendar({
        working_days: [5, 1, 3],
        holidays: [
          { date: "2026-12-25", name: "Christmas Day" },
          { date: "2026-01-01", name: "New Year" },
        ],
      })
    );
    expect(saved.status).toBe(200);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      working_days: [1, 3, 5],
      holidays: [
        { date: "2026-01-01", name: "New Year" },
        { date: "2026-12-25", name: "Christmas Day" },
      ],
      fiscal_year_start_month: 4,
      time_zone: "Europe/Paris",
    });
    expect(typeof res.body.updated_at).toBe("string");
    expect(saved.body).toEqual(res.body);
  });

  it("replaces the holidays and the rest on the next PUT", async () => {
    await put(validCalendar());
    await put(validCalendar({ holidays: [], fiscal_year_start_month: 7 }));
    const res = await get();
    expect(res.body.holidays).toEqual([]);
    expect(res.body.fiscal_year_start_month).toBe(7);
  });
});
