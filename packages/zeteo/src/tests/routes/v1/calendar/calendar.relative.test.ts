// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../../../support/http.js";
import { localDate } from "../../../../calendar/calendar.js";
import { removeSources } from "../../../support/sources.js";
import { ENGINES } from "../../../support/engines.js";
import {
  calendarWriteToken,
  resetCalendar,
  validCalendar,
} from "../../../support/calendar.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// The stored time zone reaches the planner. The fixture's order 5 is at
// 2026-03-01 00:00 UTC, which is 2026-02-28 18:00 in Chicago.
describe("the stored calendar in POST /v1/query", () => {
  let source: SeededSource;
  const user = newQueryUser();

  const put = (body: unknown) =>
    fetchJson("PUT", `${BASE_URL}/v1/calendar`, calendarWriteToken(), body);

  const DAY_MS = 86_400_000;
  /** Whole days from `from` (a "YYYY-MM-DD" date) to the fixture's day. */
  const daysTo = (from: string, to: string) =>
    Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

  /** Orders on the local day `offset` days from today. */
  const ordersOn = async (offset: number) => {
    const res = await postQuery(user.token, {
      source: source.slug,
      from: "orders",
      select: [{ count: "*", as: "orders" }],
      where: {
        and: [
          {
            created_at: {
              gte: { relative: { unit: "day", offset, startOf: true } },
            },
          },
          {
            created_at: {
              lt: {
                relative: { unit: "day", offset: offset + 1, startOf: true },
              },
            },
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return Number(res.body.rows[0][0]);
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "calendar");
    await grantTo(user.principal, source.tables.orders!, "all");
  });
  afterAll(async () => {
    await resetCalendar();
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
  });

  it("binds the date in the stored zone", async () => {
    const chicago = "America/Chicago";
    expect(
      (await put(validCalendar({ time_zone: chicago, holidays: [] }))).status
    ).toBe(200);
    const offset = daysTo(localDate(new Date(), chicago), "2026-02-28");
    expect(await ordersOn(offset)).toBe(1);
    // The UTC day before it holds no order, in Chicago either.
    expect(await ordersOn(offset - 1)).toBe(0);
    expect(await ordersOn(offset + 1)).toBe(0);
  });
});
