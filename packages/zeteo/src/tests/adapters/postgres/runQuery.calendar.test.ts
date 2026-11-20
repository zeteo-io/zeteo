// @module-tag int
// @module-tag platform
import { describeZonedGrouping } from "../../support/zonedGrouping.js";
import { describeBusinessDays } from "../../support/businessDays.js";
import { usePostgresRuns } from "../../support/postgresRuns.js";
import { describe, expect, it } from "vitest";
import {
  businessDaysElapsed,
  DEFAULT_CALENDAR,
  type Calendar,
} from "../../../calendar/calendar.js";

const { runWithCalendar } = usePostgresRuns();

describeBusinessDays("postgres", runWithCalendar);
describeZonedGrouping("postgres", runWithCalendar);

describe("postgres runQuery: business days of infinite and BC dates", () => {
  // sales.typed_values: row 2 holds infinity (day, aware) and -infinity
  // (naive); row 3 a BC day, a year-99 naive and a 1999 aware timestamp.
  const tuesdays: Calendar = { ...DEFAULT_CALENDAR, workingDays: [1, 2, 3] };

  it("gives null for an infinite date or timestamp, row by row", async () => {
    for (const calendar of [
      tuesdays,
      { ...tuesdays, timeZone: "America/Los_Angeles" },
    ]) {
      const result = await runWithCalendar(calendar, {
        from: "typed_values",
        select: [
          "id",
          { calc: { businessDaysElapsed: "day" }, as: "day_days" },
          { calc: { businessDaysElapsed: "naive" }, as: "naive_days" },
          { calc: { businessDaysElapsed: "aware" }, as: "aware_days" },
          { calc: { addBusinessDays: ["day", 1] }, as: "next" },
        ],
        where: { id: { in: [2, 3] } },
        orderBy: [{ id: "asc" }],
      });
      // 1999-12-31 23:00 at -05:00 is 2000-01-01 04:00 UTC; in Los Angeles,
      // more than 25 years back, it has no zone offset to read: null.
      const aware =
        calendar.timeZone === "UTC"
          ? businessDaysElapsed(calendar, "2000-01-01")
          : null;
      expect(result.rows).toEqual([
        [2, null, null, null, null],
        [3, null, null, aware, null],
      ]);
    }
  });

  it("matches neither isBusinessDay true nor false for an infinite or BC date", async () => {
    const ids = async (is: boolean) =>
      (
        await runWithCalendar(tuesdays, {
          from: "typed_values",
          select: ["id"],
          where: { day: { isBusinessDay: is } },
          orderBy: [{ id: "asc" }],
        })
      ).rows.map((r) => r[0]);
    // Row 1 is Tuesday 2026-03-31, row 5 Thursday 2026-01-01.
    expect(await ids(true)).toEqual([1]);
    expect(await ids(false)).toEqual([5]);
    for (const column of ["naive", "aware"]) {
      const both = await Promise.all(
        [true, false].map((is) =>
          runWithCalendar(tuesdays, {
            from: "typed_values",
            select: ["id"],
            where: { [column]: { isBusinessDay: is } },
          })
        )
      );
      const seen = both.flatMap((r) => r.rows.map((row) => row[0]));
      expect(seen, column).not.toContain(2);
    }
  });
});
