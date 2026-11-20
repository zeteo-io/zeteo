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
      /^select \(select cast\(case when "bd5"\."na" >= 0 and "bd5"\."nb" >= 0 then .* end as int\) as "n" from \(select "bd4"\.\*, .* offset 0\) as "bd5"\) as "c0" from "shop"\."orders" as "t0"/
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

  it("applies a per-row count to every row on SQL Server, the holidays a VALUES list of ordinals", () => {
    const { sql, parameters } = ms(
      calc({ businessDays: ["ordered_on", "ordered_on"] }),
      { holidays: HOLIDAYS }
    );
    expect(sql).toMatch(
      /^select \[m0\]\.\[n\] as \[c0\] from \[shop\]\.\[orders\] as \[t0\] outer apply \(select cast\(.*\) as \[n\] from .*\) as \[m0\]/
    );
    // Not OPENJSON, which SQL Server parses again on every row.
    expect(sql).not.toContain("openjson");
    expect(sql.match(/\(values \(\d+\), \(\d+\)\) as h\(v\)/g)).toHaveLength(2);
    // Only the page is bound.
    expect(parameters).toHaveLength(2);
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

  it("reads a timestamp in the calendar's zone: natively on Postgres, by the zone's offsets on SQL Server", () => {
    const zoned = { timeZone: "America/Los_Angeles" };
    const query = calc({ businessDaysIn: ["week", "created_at"] });
    const postgres = pg(query, zoned);
    expect(postgres.sql).toContain(
      `(select "bd0".*, case when cast("bd0"."dx" as timestamptz) >= cast($3 as timestamptz) and cast("bd0"."dx" as timestamptz) < cast($4 as timestamptz) then cast(cast("bd0"."dx" as timestamptz) at time zone cast($5 as text) as date) end as "d0" from (select "t0"."created_at" as "dx" offset 0) as "bd0" offset 0)`
    );
    expect(postgres.parameters.slice(2, 5)).toEqual([
      "2001-01-01T00:00:00.000Z",
      "2052-01-01T00:00:00.000Z",
      "America/Los_Angeles",
    ]);
    const mssql = ms(query, zoned);
    // No JSON read per row: the spans as a VALUES table of the planner's instants.
    expect(mssql.sql).not.toContain("openjson");
    expect(mssql.sql).toContain(
      "cast(dateadd(second, (select z.o from (values (cast('2001-01-01T00:00:00' as datetime2(7)), cast('2001-04-01T10:00:00' as datetime2(7)), -28800), "
    );
    expect(mssql.sql).toContain(
      ") as z(s, e, o) where z.s <= [bd0].[dx] and [bd0].[dx] < z.e), [bd0].[dx]) as date) as [d0]"
    );
  });

  it("converts a timestamp once per function, in a fenced step, however often it reads the date", () => {
    const zoned = { timeZone: "America/Los_Angeles" };
    for (const expr of [
      { businessDaysIn: ["fiscal_year", "created_at"] },
      { addBusinessDays: ["created_at", 3] },
      { businessDaysBetween: ["created_at", "created_at"] },
    ]) {
      const count = (sql: string, text: string) => sql.split(text).length - 1;
      const operands = JSON.stringify(expr).split("created_at").length - 1;
      expect(count(pg(calc(expr), zoned).sql, "at time zone cast(")).toBe(
        operands
      );
      expect(count(ms(calc(expr), zoned).sql, "dateadd(second, ")).toBe(
        operands
      );
      // Each step is fenced, so neither optimizer pulls it up and repeats it.
      const pgSql = pg(calc(expr), zoned).sql;
      expect(count(pgSql, " offset 0)")).toBe(count(pgSql, "(select ") - 1);
      expect(ms(calc(expr), zoned).sql).toContain("(select top 1 [bd0].*, ");
    }
  });

  it("reads a UTC timestamp as its date, with nothing bound for the zone", () => {
    const { sql, parameters } = pg(
      calc({ businessDaysIn: ["week", "created_at"] })
    );
    expect(sql).toContain('cast("bd0"."dx" as date) as "d0"');
    // Only the bucket's unit, twice, and the page.
    expect(parameters).toEqual(["week", "week", 1001, 0]);
  });

  it("makes addBusinessDays a date from the subquery's day number", () => {
    expect(pg(calc({ addBusinessDays: ["ordered_on", "id"] })).sql).toMatch(
      /^select \(date '1900-01-01' \+ \(select cast\(case when "bd8"\."n" >= 0 and "bd8"\."t" >= 1 and "bd8"\."r" <= 2958098 then "bd8"\."r" end as int\)/
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

describe("compileSql: buckets and date parts in the calendar's zone", () => {
  const zoned = { timeZone: "America/Los_Angeles" };
  const byWeek = {
    select: [
      { bucket: "week", column: "created_at", as: "w" },
      { count: "*", as: "n" },
    ],
    groupBy: ["w"],
  };

  it("buckets a timestamp's local date natively on Postgres, the zone bound", () => {
    const { sql, parameters } = pg(byWeek, zoned);
    expect(sql).toBe(
      'select date_trunc($1, case when cast("t0"."created_at" as timestamptz) >= cast($2 as timestamptz) and cast("t0"."created_at" as timestamptz) < cast($3 as timestamptz) then cast(cast("t0"."created_at" as timestamptz) at time zone cast($4 as text) as date) end)::date as "c0",' +
        ' count(*) as "c1" from "shop"."orders" as "t0" group by 1 limit $5 offset $6'
    );
    expect(parameters.slice(0, 4)).toEqual([
      "week",
      "2001-01-01T00:00:00.000Z",
      "2052-01-01T00:00:00.000Z",
      "America/Los_Angeles",
    ]);
  });

  it("applies the conversion to each row on SQL Server and groups by its column", () => {
    const { sql } = ms(byWeek, zoned);
    expect(sql).toMatch(
      /^select cast\(datetrunc\(iso_week, \[m0\]\.\[n\]\) as date\) as \[c0\], count_big\(\*\) as \[c1\] from \[shop\]\.\[orders\] as \[t0\] outer apply \(select cast\(dateadd\(second, \(select z\.o from \(values .*\) as z\(s, e, o\) where z\.s <= (cast\(switchoffset\(\[t0\]\.\[created_at\], '\+00:00'\) as datetime2\(7\)\)) and \1 < z\.e\), \1\) as date\) as \[n\]\) as \[m0\] group by cast\(datetrunc\(iso_week, \[m0\]\.\[n\]\) as date\)/
    );
  });

  it("leaves a date column as it is, with nothing bound for the zone", () => {
    const { sql, parameters } = pg(
      { select: [{ bucket: "month", column: "ordered_on", as: "m" }] },
      zoned
    );
    expect(sql).toContain('date_trunc($1, "t0"."ordered_on")::date as "c0"');
    expect(parameters).toEqual(["month", 1001, 0]);
  });

  it("reads a date part of a timestamp in the zone, per row on SQL Server", () => {
    const query = calc({ datePart: ["weekday", "created_at"] });
    expect(pg(query, zoned).sql).toContain(
      'cast(extract(isodow from case when cast("t0"."created_at" as timestamptz) >= '
    );
    expect(ms(query, zoned).sql).toMatch(
      /^select \(\(datepart\(weekday, \[m0\]\.\[n\]\) \+ @@datefirst \+ 5\) % 7 \+ 1\) as \[c0\] from \[shop\]\.\[orders\] as \[t0\] outer apply \(select cast\(dateadd\(second, /
    );
    // UTC: no conversion at all.
    expect(pg(query).sql).toContain(
      'cast(extract(isodow from "t0"."created_at") as integer)'
    );
  });
});
