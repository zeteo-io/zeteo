// @module-tag unit
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";

const compileOn =
  (dialect: SqlDialect) =>
  (query: object, fetch = { limit: 1001, offset: 0 }) =>
    compileSql(
      planSql(
        sqlQuerySchema.parse({
          source: "shop",
          from: "orders",
          select: ["id"],
          ...query,
        }),
        shopCatalog({ engine: dialect.name })
      ),
      dialect,
      fetch
    );

const pg = compileOn(postgresDialect);
const ms = compileOn(mssqlDialect);

/** One calc select item, unordered, from `orders` (or `from`), with its joins. */
const calcQuery = (calc: unknown, extra: object = {}) => ({
  select: [{ calc, as: "x" }],
  orderBy: [],
  ...extra,
});

const nvarchar = (value: string) => ({ type: "nvarchar", value });
const bigint = (value: string) => ({ type: "bigint", value });

describe("compileSql on Postgres: calculations", () => {
  const FROM = ' as "c0" from "shop"."orders" as "t0"';
  const page = (used: number) => ` limit $${used + 1} offset $${used + 2}`;
  /** The select expression and the parameters before paging. */
  const selected = (calc: unknown, extra: object = {}) => {
    const { sql, parameters } = pg(calcQuery(calc, extra));
    return { sql, parameters: parameters.slice(0, -2) };
  };

  it("joins add, sub and mul operands in parentheses and binds literals with a type", () => {
    const { sql, parameters } = selected({
      add: ["total", 1, { mul: ["customer_id", 2.5] }, { sub: ["id", -3] }],
    });
    expect(sql).toBe(
      'select ("t0"."total" + cast($1 as bigint) + ("t0"."customer_id" * cast($2 as numeric))' +
        ' + ("t0"."id" - cast($3 as bigint)))' +
        FROM +
        page(3)
    );
    expect(parameters).toEqual(["1", "2.5", "-3"]);
  });

  it("binds an integer past bigint as numeric", () => {
    const { sql, parameters } = selected({
      add: ["id", 9_223_372_036_854_775_808],
    });
    expect(sql).toContain("cast($1 as numeric)");
    expect(parameters).toEqual(["9223372036854776000"]);
  });

  it("divides as decimals with a zero guard, rounded to 6 places", () => {
    expect(selected({ div: ["total", "customer_id"] }).sql).toBe(
      'select round(cast("t0"."total" as numeric(38, 18)) / nullif(cast("t0"."customer_id" as numeric(38, 10)), 0), 6)' +
        FROM +
        page(0)
    );
  });

  it("rounds a decimal to the given places, 0 when none are given", () => {
    expect(selected({ round: ["total", 2] }).sql).toBe(
      'select round(cast("t0"."total" as numeric(38, 10)), 2)' + FROM + page(0)
    );
    expect(selected({ round: "total" }).sql).toContain(
      'round(cast("t0"."total" as numeric(38, 10)), 0)'
    );
  });

  it("compiles abs, lower, upper and coalesce as functions", () => {
    expect(selected({ abs: "total" }).sql).toContain('abs("t0"."total")');
    expect(selected({ lower: "status" }).sql).toContain('lower("t0"."status")');
    expect(selected({ upper: "status" }).sql).toContain('upper("t0"."status")');
    const { sql, parameters } = selected({
      coalesce: ["notes", "status", { value: "-" }],
    });
    expect(sql).toContain(
      'coalesce("t0"."notes", "t0"."status", cast($1 as text))'
    );
    expect(parameters).toEqual(["-"]);
    expect(selected({ coalesce: ["ordered_on", "ordered_on"] }).sql).toContain(
      'coalesce("t0"."ordered_on", "t0"."ordered_on")'
    );
  });

  it("concatenates text, with numbers as their decimal text", () => {
    const { sql, parameters } = selected({
      concat: ["status", { value: " #" }, "id", 7],
    });
    expect(sql).toContain(
      'concat("t0"."status", cast($1 as text), cast("t0"."id" as text), cast(cast($2 as bigint) as text))'
    );
    expect(parameters).toEqual([" #", "7"]);
  });

  it("writes a float as its decimal text, at most 10 places and no trailing zeros", () => {
    const { sql } = pg({
      select: [
        { calc: { concat: [{ value: "avg " }, { avg: "total" }] }, as: "x" },
      ],
      orderBy: [],
    });
    expect(sql).toContain(
      `concat(cast($1 as text), rtrim(rtrim(cast(round(cast(avg("t0"."total")::float8 as numeric), 10) as text), '0'), '.'))`
    );
  });

  it("reads a uuid as text inside a calculation", () => {
    expect(pg(calcQuery({ lower: "ref" }, { from: "ledger" })).sql).toContain(
      'lower(cast("t0"."ref" as text))'
    );
  });

  it("puts aggregates inside a group-level calculation", () => {
    const { sql } = pg({
      join: ["customer"],
      select: [
        "customer.region",
        {
          calc: {
            mul: [100, { div: [{ sum: "total" }, { count: "*" }] }],
          },
          as: "x",
        },
      ],
      groupBy: ["customer.region"],
      orderBy: [],
    });
    expect(sql).toBe(
      'select "t1"."region" as "c0", (cast($1 as bigint) * round(cast(sum("t0"."total") as numeric(38, 18))' +
        ' / nullif(cast(count(*) as numeric(38, 10)), 0), 6)) as "c1"' +
        ' from "shop"."orders" as "t0" inner join "shop"."customers" as "t1" on "t0"."customer_id" = "t1"."id"' +
        " group by 1" +
        page(1)
    );
  });

  it("filters on a row calc by its expression, and having on a group calc", () => {
    const { sql, parameters } = pg({
      select: [
        "status",
        { calc: { mul: ["total", 2] }, as: "double" },
        { calc: { div: [{ sum: "total" }, { count: "*" }] }, as: "mean" },
      ],
      where: { double: { gt: 100 } },
      groupBy: ["status", "double"],
      having: { mean: { gte: 1 } },
      orderBy: [],
    });
    expect(sql).toBe(
      'select "t0"."status" as "c0", ("t0"."total" * cast($1 as bigint)) as "c1",' +
        ' round(cast(sum("t0"."total") as numeric(38, 18)) / nullif(cast(count(*) as numeric(38, 10)), 0), 6) as "c2"' +
        ' from "shop"."orders" as "t0"' +
        ' where ("t0"."total" * cast($2 as bigint)) > $3' +
        " group by 1, 2" +
        ' having round(cast(sum("t0"."total") as numeric(38, 18)) / nullif(cast(count(*) as numeric(38, 10)), 0), 6) >= $4' +
        page(4)
    );
    expect(parameters.slice(0, 4)).toEqual(["2", "2", 100, 1]);
  });

  it("binds a number literal in exponent form as plain decimal text", () => {
    const { sql, parameters } = selected({
      concat: [0.0000001, 1e21, "status"],
    });
    expect(sql).toContain(
      "concat(cast(cast($1 as numeric) as text), cast(cast($2 as numeric) as text), "
    );
    expect(parameters).toEqual(["0.0000001", "1000000000000000000000"]);
  });

  // The database's own out-of-range error (22003) is reserved for overflow
  // in a calculation, which is the query's failure, not the caller's value.
  it("refuses a number value past numeric's range before the database sees it", () => {
    let err: unknown;
    try {
      pg({
        select: ["id"],
        where: { total: { gt: "9".repeat(140_000) } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QueryError);
    expect(err).toMatchObject({ code: "invalid_value" });
  });
});

describe("compileSql on SQL Server: calculations", () => {
  const FROM = " as [c0] from [shop].[orders] as [t0]";
  const page = (used: number) =>
    ` order by (select null) offset @${used + 1} rows fetch next @${used + 2} rows only`;
  const selected = (calc: unknown, extra: object = {}) => {
    const { sql, parameters } = ms(calcQuery(calc, extra));
    return { sql, parameters: parameters.slice(0, -2) };
  };
  const asDecimalText = (expression: string) =>
    `cast(${expression} as varchar(48))`;

  it("joins add, sub and mul operands in parentheses and binds literals with a type", () => {
    const { sql, parameters } = selected({
      add: ["total", 1, { mul: ["customer_id", 2.5] }, { sub: ["id", -3] }],
    });
    expect(sql).toBe(
      "select " +
        asDecimalText(
          "([t0].[total] + @1 + ([t0].[customer_id] * cast(@2 as decimal(2, 1))) + ([t0].[id] - @3))"
        ) +
        FROM +
        page(3)
    );
    expect(parameters).toEqual([bigint("1"), nvarchar("2.5"), bigint("-3")]);
  });

  it("reads an integer result as it is and a money result in money's style", () => {
    expect(selected({ add: ["customer_id", 1] }).sql).toBe(
      "select ([t0].[customer_id] + @1)" + FROM + page(1)
    );
    expect(ms(calcQuery({ abs: "amount" }, { from: "ledger" })).sql).toContain(
      "select convert(varchar(48), abs([t0].[amount]), 2) as [c0]"
    );
  });

  it("divides as decimals with a zero guard, rounded to 6 places", () => {
    expect(selected({ div: ["total", "customer_id"] }).sql).toBe(
      "select " +
        asDecimalText(
          "cast(round(cast([t0].[total] as decimal(38, 18)) / nullif(cast([t0].[customer_id] as decimal(38, 10)), 0), 6) as decimal(38, 6))"
        ) +
        FROM +
        page(0)
    );
  });

  it("rounds through decimal(38, 10) to exactly the given places", () => {
    expect(selected({ round: ["total", 2] }).sql).toBe(
      "select " +
        asDecimalText(
          "cast(round(cast([t0].[total] as decimal(38, 10)), 2) as decimal(38, 2))"
        ) +
        FROM +
        page(0)
    );
  });

  it("compiles abs, lower, upper and coalesce as functions", () => {
    expect(selected({ abs: "total" }).sql).toContain(
      asDecimalText("abs([t0].[total])")
    );
    expect(selected({ lower: "status" }).sql).toContain(
      "select lower([t0].[status]) as [c0]"
    );
    expect(selected({ upper: "status" }).sql).toContain("upper([t0].[status])");
    const { sql, parameters } = selected({
      coalesce: ["notes", "status", { value: "-" }],
    });
    expect(sql).toContain("coalesce([t0].[notes], [t0].[status], @1)");
    expect(parameters).toEqual([nvarchar("-")]);
  });

  it("concatenates text, with numbers as their decimal text", () => {
    const { sql, parameters } = selected({
      concat: ["status", { value: " #" }, "total", 7],
    });
    expect(sql).toContain(
      "concat([t0].[status], @1, cast([t0].[total] as nvarchar(64)), cast(@2 as nvarchar(64)))"
    );
    expect(parameters).toEqual([nvarchar(" #"), bigint("7")]);
  });

  it("writes a float as its decimal text, at most 10 places and no trailing zeros", () => {
    const { sql } = ms({
      select: [
        { calc: { concat: [{ value: "avg " }, { avg: "total" }] }, as: "x" },
      ],
      orderBy: [],
    });
    expect(sql).toContain(
      "concat(@1, replace(rtrim(replace(replace(rtrim(replace(" +
        "cast(cast(cast(sum([t0].[total]) as float) / nullif(count_big([t0].[total]), 0) as decimal(38, 10)) as nvarchar(64))" +
        ", '0', ' ')), ' ', '0'), '.', ' ')), ' ', '.'))"
    );
  });

  it("reads a uniqueidentifier as lower-case text inside a calculation", () => {
    expect(ms(calcQuery({ upper: "ref" }, { from: "ledger" })).sql).toContain(
      "upper(lower(cast([t0].[ref] as nvarchar(36))))"
    );
  });

  it("groups by a row calc with the same parameter the select list binds", () => {
    const { sql, parameters } = ms({
      select: [
        { calc: { mul: ["customer_id", 2] }, as: "double" },
        { count: "*", as: "n" },
      ],
      groupBy: ["double"],
    });
    const double = "([t0].[customer_id] * @1)";
    expect(sql).toBe(
      `select ${double} as [c0], count_big(*) as [c1] from [shop].[orders] as [t0]` +
        ` group by ${double}` +
        ` order by case when ${double} is null then 1 else 0 end, ${double} asc,` +
        " case when count_big(*) is null then 1 else 0 end, count_big(*) asc" +
        " offset @2 rows fetch next @3 rows only"
    );
    expect(parameters).toEqual([bigint("2"), bigint("0"), bigint("1001")]);
  });

  it("orders by each distinct expression once, as SQL Server refuses a repeat", () => {
    const order = (e: string, dir = "asc") =>
      `case when ${e} is null then ${dir === "asc" ? "1 else 0" : "0 else 1"} end, ${e} ${dir}`;
    const tail = " offset @1 rows fetch next @2 rows only";
    expect(ms({ select: ["id", { calc: "id", as: "same" }] }).sql).toBe(
      "select [t0].[id] as [c0], [t0].[id] as [c1] from [shop].[orders] as [t0]" +
        ` order by ${order("[t0].[id]")}${tail}`
    );
    expect(
      ms({
        select: [
          { sum: "total" },
          { calc: { sum: "total" }, as: "t" },
          { sum: "total", as: "again" },
        ],
      }).sql
    ).toBe(
      "select cast(sum([t0].[total]) as varchar(48)) as [c0], cast(sum([t0].[total]) as varchar(48)) as [c1]," +
        " cast(sum([t0].[total]) as varchar(48)) as [c2]" +
        ` from [shop].[orders] as [t0] order by ${order("sum([t0].[total])")}${tail}`
    );
    expect(
      ms({
        select: ["id", { calc: "id", as: "same" }, "total"],
        orderBy: [{ same: "desc" }, { id: "asc" }, { total: "asc" }],
      }).sql
    ).toBe(
      "select [t0].[id] as [c0], [t0].[id] as [c1], cast([t0].[total] as varchar(48)) as [c2]" +
        " from [shop].[orders] as [t0]" +
        ` order by ${order("[t0].[id]", "desc")}, ${order("[t0].[total]")}${tail}`
    );
  });

  it("orders by a repeated expression once on Postgres too", () => {
    expect(pg({ select: ["id", { calc: "id", as: "same" }] }).sql).toBe(
      'select "t0"."id" as "c0", "t0"."id" as "c1" from "shop"."orders" as "t0"' +
        ' order by "c0" asc nulls last limit $1 offset $2'
    );
  });

  it("filters on a row calc by its expression, and having on a group calc", () => {
    const { sql } = ms({
      select: [
        "status",
        { calc: { mul: ["total", 2] }, as: "double" },
        { calc: { div: [{ sum: "total" }, { count: "*" }] }, as: "mean" },
      ],
      where: { double: { gt: 100 } },
      groupBy: ["status", "double"],
      having: { mean: { gte: 1 } },
      orderBy: [],
    });
    const mean =
      "cast(round(cast(sum([t0].[total]) as decimal(38, 18)) / nullif(cast(count_big(*) as decimal(38, 10)), 0), 6) as decimal(38, 6))";
    expect(sql).toBe(
      `select [t0].[status] as [c0], cast(([t0].[total] * @1) as varchar(48)) as [c1], cast(${mean} as varchar(48)) as [c2]` +
        " from [shop].[orders] as [t0]" +
        " where ([t0].[total] * @1) > @2" +
        " group by [t0].[status], ([t0].[total] * @1)" +
        ` having ${mean} >= @3` +
        " order by (select null) offset @4 rows fetch next @5 rows only"
    );
  });

  it("treats a group-level calc as grouping when distinct", () => {
    const { sql } = ms({
      select: [{ calc: { add: [{ count: "*" }, 1] }, as: "n" }],
      distinct: true,
      orderBy: [],
    });
    expect(sql).not.toContain("group by");
  });

  it("binds a decimal literal with no more precision than its digits", () => {
    const { sql, parameters } = selected({ mul: ["total", 0.0001, 12.5] });
    expect(sql).toContain(
      "([t0].[total] * cast(@1 as decimal(4, 4)) * cast(@2 as decimal(3, 1)))"
    );
    expect(parameters).toEqual([nvarchar("0.0001"), nvarchar("12.5")]);
  });

  it("binds a number literal in exponent form as plain decimal text", () => {
    const { sql, parameters } = selected({
      concat: [0.0000001, 1e21, "status"],
    });
    expect(sql).toContain(
      "concat(cast(cast(@1 as decimal(7, 7)) as nvarchar(64)), cast(cast(@2 as decimal(22, 0)) as nvarchar(64)), "
    );
    expect(parameters).toEqual([
      nvarchar("0.0000001"),
      nvarchar("1000000000000000000000"),
    ]);
  });

  it("sums an integer expression as decimal(38, 0), returned as text", () => {
    const { sql } = ms({
      select: [
        {
          calc: { add: [{ sum: { mul: ["customer_id", "customer_id"] } }, 0] },
          as: "x",
        },
      ],
      orderBy: [],
    });
    expect(sql).toContain(
      "select cast((sum(cast(([t0].[customer_id] * [t0].[customer_id]) as decimal(38, 0))) + @1) as varchar(48)) as [c0]"
    );
  });
});

describe("compileSql: case", () => {
  const sumCase = {
    select: [
      {
        sum: {
          case: { when: [{ if: { status: { eq: "paid" } }, then: "total" }] },
        },
        as: "paid",
      },
    ],
    orderBy: [],
  };

  it("compiles a case on Postgres, each when through the where compiler", () => {
    const { sql, parameters } = pg(
      calcQuery({
        case: {
          when: [
            { if: { status: { eq: "paid" } }, then: { value: "a" } },
            { if: { total: { gt: 100 } }, then: { value: "b" } },
          ],
          else: "status",
        },
      })
    );
    expect(sql).toBe(
      'select case when "t0"."status" = $1 then cast($2 as text) when "t0"."total" > $3 then cast($4 as text) else "t0"."status" end as "c0" from "shop"."orders" as "t0" limit $5 offset $6'
    );
    expect(parameters.slice(0, 4)).toEqual(["paid", "a", 100, "b"]);
  });

  it("compiles a conditional sum on both engines", () => {
    expect(pg(sumCase).sql).toContain(
      'select sum(case when "t0"."status" = $1 then "t0"."total" end)'
    );
    expect(ms(sumCase).sql).toContain(
      "sum(case when [t0].[status] = @1 then [t0].[total] end)"
    );
    expect(ms(sumCase).parameters[0]).toEqual(nvarchar("paid"));
  });

  it("compiles a case with an else on SQL Server", () => {
    const { sql } = ms(
      calcQuery({
        case: {
          when: [{ if: { status: { eq: "paid" } }, then: "total" }],
          else: 0,
        },
      })
    );
    expect(sql).toContain(
      "case when [t0].[status] = @1 then [t0].[total] else @2 end"
    );
  });

  it("compiles count over a case", () => {
    expect(
      pg({
        select: [
          {
            count: { case: { when: [{ if: { id: { eq: 1 } }, then: 1 }] } },
            as: "n",
          },
        ],
        orderBy: [],
      }).sql
    ).toContain('count(case when "t0"."id" = $1 then cast($2 as bigint) end)');
  });
});

describe("planSql: bucket calendars", () => {
  const planWith = (unit: string, fiscalYearStartMonth: number) =>
    planSql(
      sqlQuerySchema.parse({
        source: "shop",
        from: "orders",
        select: [{ bucket: unit, column: "created_at", as: "b" }],
      }),
      {
        ...shopCatalog(),
        calendar: { ...DEFAULT_CALENDAR, fiscalYearStartMonth },
      }
    );

  it("plans a fiscal bucket differently when the fiscal year starts in another month", () => {
    expect(planWith("fiscal_year", 2)).not.toEqual(planWith("fiscal_year", 4));
    expect(planWith("fiscal_quarter", 2)).not.toEqual(
      planWith("fiscal_quarter", 3)
    );
  });

  it("plans a calendar bucket the same whatever the fiscal year start", () => {
    expect(planWith("month", 2)).toEqual(planWith("month", 4));
  });
});
