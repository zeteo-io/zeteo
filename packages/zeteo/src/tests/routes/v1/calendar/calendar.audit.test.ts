// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { auditRows } from "../../../support/sources.js";
import { fetchJson } from "../../../support/http.js";
import {
  calendarWriteToken,
  resetCalendar,
  validCalendar,
} from "../../../support/calendar.js";

describe("calendar audit entries", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;

  beforeAll(async () => {
    app = await startV1Routes();
    await resetCalendar();
  });
  afterAll(async () => {
    await resetCalendar();
    await app.close();
  });

  it("records one zeteo.calendar.updated entry for each PUT", async () => {
    const res = await fetchJson(
      "PUT",
      `${app.url}/v1/calendar`,
      calendarWriteToken(),
      validCalendar()
    );
    expect(res.status).toBe(200);
    const rows = await auditRows("calendar");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "calendar",
      metadata: {
        working_days: [1, 2, 3, 4, 5],
        holiday_count: 1,
        fiscal_year_start_month: 4,
        time_zone: "Europe/Paris",
        event: "zeteo.calendar.updated",
      },
    });
  });

  it("records no entry for a refused PUT", async () => {
    const before = (await auditRows("calendar")).length;
    const res = await fetchJson(
      "PUT",
      `${app.url}/v1/calendar`,
      calendarWriteToken(),
      validCalendar({ time_zone: "Mars/Olympus" })
    );
    expect(res.status).toBe(400);
    expect(await auditRows("calendar")).toHaveLength(before);
  });
});
