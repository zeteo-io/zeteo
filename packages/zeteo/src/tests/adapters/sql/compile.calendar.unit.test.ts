// @module-tag unit
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR,
  dayNumber,
  type Calendar,
} from "../../../calendar/calendar.js";

// Business-day functions compile to one scalar subquery each, steps as
// derived tables; the calendar's holidays are bound, never written into the
// text, and SQL Server, which aggregates no subquery, applies a per-row one
// to every row.

const NOW = new Date("2026-11-19T15:00:00Z");
const HOLIDAYS = new Map([
  ["2026-11-26", "Thanksgiving"],
  ["2026-12-25", "Christmas"],
]);

const compileOn =
  (dialect: SqlDialect) =>
  (query: object, calendar: Partial<Calendar> = {}) =>
    compileSql(
      planSql(
        sqlQuerySchema.parse({
          source: "shop",
          from: "orders",
          orderBy: [],
          ...query,
        }),
        {
          ...shopCatalog({ engine: dialect.name }),
          calendar: { ...DEFAULT_CALENDAR, ...calendar },
        },
        { now: NOW }
      ),
      dialect,
      { limit: 1001, offset: 0 }
    );

const pg = compileOn(postgresDialect);
const ms = compileOn(mssqlDialect);

const calc = (expr: unknown) => ({ select: [{ calc: expr, as: "x" }] });

describe("compileSql: business days", () => {
  it("computes a count in one scalar subquery whose steps are derived tables", () => {
    const { sql } = pg(
      calc({ businessDaysBetween: ["ordered_on", "ordered_on"] })
    );
    expect(sql).toMatch(
      /^select \(select cast\(case when "bd3"\."na" >= 0 and "bd3"\."nb" >= 0 then .* end as int\) as "n" from \(select "bd2"\.\*, .* from \(select "bd1"\.\*, .* from \(select "bd0"\.\*, .* from \(select cast\("t0"\."ordered_on" as date\) as "a", cast\("t0"\."ordered_on" as date\) as "b"\) as "bd0"\) as "bd1"\) as "bd2"\) as "bd3"\) as "c0" from "shop"\."orders" as "t0"/
    );
  });

  it("binds the holidays as working-weekday ordinals, one int array per count on Postgres", () => {
    const { sql, parameters } = pg(
      calc({ businessDays: ["ordered_on", "ordered_on"] }),
      { holidays: HOLIDAYS }
    );
    expect(sql).toContain(
      "(select count(*) from unnest(cast($1 as int[])) as h(v) where h.v <= "
    );
    // 2026-11-26 is the anchor's day 46,349: 6,621 weeks and 2 days in, a Thursday.
    const ordinal = (date: string) => {
      const n = dayNumber(date);
      return Math.floor(n / 7) * 5 + Math.min((n % 7) + 1, 5);
    };
    expect(parameters.slice(0, 2)).toEqual([
      [ordinal("2026-11-26"), ordinal("2026-12-25")],
      [ordinal("2026-11-26"), ordinal("2026-12-25")],
    ]);
  });

  it("writes no holiday lookup for a calendar without holidays", () => {
    const { sql } = pg(calc({ businessDays: ["ordered_on", "ordered_on"] }));
    expect(sql).not.toContain("unnest");
  });

  it("applies a per-row count to every row on SQL Server, the holidays bound once as JSON", () => {
    const { sql, parameters } = ms(
      calc({ businessDays: ["ordered_on", "ordered_on"] }),
      { holidays: HOLIDAYS }
    );
    expect(sql).toMatch(
      /^select \[m0\]\.\[n\] as \[c0\] from \[shop\]\.\[orders\] as \[t0\] outer apply \(select cast\(.*\) as \[n\] from .*\) as \[m0\]/
    );
    expect(sql.match(/openjson\(@1\) with \(v int '\$'\)/g)).toHaveLength(2);
    expect(parameters[0]).toEqual({
      type: "nvarchar",
      value: expect.stringMatching(/^\[\d+,\d+\]$/),
    });
  });

  it("keeps a group-level count inline on SQL Server", () => {
    const { sql } = ms({
      select: [
        {
          calc: {
            businessDaysBetween: [{ min: "ordered_on" }, { max: "ordered_on" }],
          },
          as: "x",
        },
      ],
    });
    expect(sql).not.toContain("outer apply");
    expect(sql).toContain("min([t0].[ordered_on])");
  });

  it("reads a timestamp in the calendar's zone: natively on Postgres, by bound offsets on SQL Server", () => {
    const zoned = { timeZone: "America/Los_Angeles" };
    const query = calc({ businessDaysIn: ["week", "created_at"] });
    const postgres = pg(query, zoned);
    expect(postgres.sql).toContain(
      'case when cast("t0"."created_at" as timestamptz) >= cast($3 as timestamptz) and cast("t0"."created_at" as timestamptz) < cast($4 as timestamptz) then cast(cast("t0"."created_at" as timestamptz) at time zone cast($5 as text) as date) end as "d"'
    );
    // After the bucket's unit, twice, in the outer steps.
    expect(postgres.parameters.slice(2, 5)).toEqual([
      "2001-01-01T00:00:00.000Z",
      "2052-01-01T00:00:00.000Z",
      "America/Los_Angeles",
    ]);
    const mssql = ms(query, zoned);
    expect(mssql.sql).toContain(
      "cast(dateadd(second, (select z.o from openjson(@1) with (s datetime2(7) '$.s', e datetime2(7) '$.e', o int '$.o') as z where z.s <= cast(cast(switchoffset([t0].[created_at], '+00:00') as datetime2(7)) as datetime2(7))"
    );
    const spans = JSON.parse(
      (mssql.parameters[0] as { value: string }).value
    ) as { s: string; e: string; o: number }[];
    expect(spans[0]).toEqual({
      s: "2001-01-01T00:00:00",
      e: "2001-04-01T10:00:00",
      o: -28_800,
    });
    expect(spans.at(-1)!.e).toBe("2052-01-01T00:00:00");
  });

  it("reads a UTC timestamp as its date, with nothing bound for the zone", () => {
    const { sql, parameters } = pg(
      calc({ businessDaysIn: ["week", "created_at"] })
    );
    expect(sql).toContain('(select cast("t0"."created_at" as date) as "d")');
    // Only the bucket's unit, twice, and the page.
    expect(parameters).toEqual(["week", "week", 1001, 0]);
  });

  it("makes addBusinessDays a date from the subquery's day number", () => {
    expect(pg(calc({ addBusinessDays: ["ordered_on", "id"] })).sql).toMatch(
      /^select \(date '1900-01-01' \+ \(select cast\(case when "bd6"\."n" >= 0 and "bd6"\."t" >= 1 and "bd6"\."r" <= 2958463 then "bd6"\."r" end as int\)/
    );
    expect(ms(calc({ addBusinessDays: ["ordered_on", "id"] })).sql).toMatch(
      /^select dateadd\(day, \[m0\]\.\[n\], cast\('1900-01-01' as date\)\) as \[c0\]/
    );
  });

  it("filters isBusinessDay by the subquery's flag, applied per row on SQL Server", () => {
    const where = (is: boolean) => ({
      select: ["id"],
      where: { ordered_on: { isBusinessDay: is } },
    });
    expect(pg(where(true)).sql).toMatch(/ where \(select cast\(.*\) = 1 limit/);
    expect(pg(where(false)).sql).toMatch(/ = 0 limit/);
    expect(ms(where(true)).sql).toMatch(
      / outer apply \(select .*\) as \[m0\] where \[m0\]\.\[n\] = 1 /
    );
  });
});
