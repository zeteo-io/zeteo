// @module-tag unit
// @module-tag platform
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";

const plan = (query: object) =>
  planSql(
    sqlQuerySchema.parse({
      source: "shop",
      from: "orders",
      select: ["id"],
      ...query,
    }),
    shopCatalog({ engine: "mssql" })
  );

const compile = (query: object, fetch = { limit: 1001, offset: 0 }) =>
  compileSql(plan(query), mssqlDialect, fetch);

const nvarchar = (value: string) => ({ type: "nvarchar", value });
const bigint = (value: string) => ({ type: "bigint", value });
const PAGE = [bigint("0"), bigint("1001")];

/** Nulls last ascending, first descending, then the value itself. */
const by = (expression: string, direction: "asc" | "desc" = "asc") =>
  direction === "asc"
    ? `case when ${expression} is null then 1 else 0 end, ${expression} asc`
    : `case when ${expression} is null then 0 else 1 end, ${expression} desc`;
const tail = (used = 0) =>
  ` offset @${used + 1} rows fetch next @${used + 2} rows only`;
const ORDERED = ` order by ${by("[t0].[id]")}${tail()}`;

describe("compileSql on SQL Server: shape", () => {
  it("selects columns positionally aliased, ordered by every item, paged by parameters", () => {
    expect(
      compile({ select: ["id", "status"] }, { limit: 11, offset: 20 })
    ).toEqual({
      sql:
        "select [t0].[id] as [c0], [t0].[status] as [c1] from [shop].[orders] as [t0]" +
        ` order by ${by("[t0].[id]")}, ${by("[t0].[status]")}` +
        " offset @1 rows fetch next @2 rows only",
      parameters: [bigint("20"), bigint("11")],
    });
  });

  it("ignores the query's own limit and offset in favour of fetch", () => {
    expect(compile({ limit: 5, offset: 7 }).sql).toBe(
      "select [t0].[id] as [c0] from [shop].[orders] as [t0]" + ORDERED
    );
    expect(
      compile({ limit: 5, offset: 7 }, { limit: 6, offset: 7 }).parameters
    ).toEqual([bigint("7"), bigint("6")]);
  });

  it("addresses a table in another schema by schema and name, and returns a decimal as text", () => {
    expect(compile({ from: "billing.accounts", select: ["balance"] }).sql).toBe(
      "select cast([t0].[balance] as varchar(48)) as [c0] from [billing].[accounts] as [t0]" +
        ` order by ${by("[t0].[balance]")}${tail()}`
    );
  });

  it("emits distinct as a group by every item, which the null ordering may use", () => {
    expect(compile({ select: ["status", "id"], distinct: true }).sql).toBe(
      "select [t0].[status] as [c0], [t0].[id] as [c1] from [shop].[orders] as [t0]" +
        " group by [t0].[status], [t0].[id]" +
        ` order by ${by("[t0].[status]")}, ${by("[t0].[id]")}${tail()}`
    );
  });

  it("drops distinct from a grouped query, whose rows are distinct already", () => {
    expect(
      compile({
        select: ["status", { count: "*", as: "n" }],
        groupBy: ["status"],
        distinct: true,
      }).sql
    ).toBe(
      "select [t0].[status] as [c0], count_big(*) as [c1] from [shop].[orders] as [t0]" +
        " group by [t0].[status]" +
        ` order by ${by("[t0].[status]")}, ${by("count_big(*)")}${tail()}`
    );
    expect(
      compile({ select: [{ count: "*", as: "n" }], distinct: true }).sql
    ).toBe(
      "select count_big(*) as [c0] from [shop].[orders] as [t0]" +
        ` order by ${by("count_big(*)")}${tail()}`
    );
  });

  it("orders by a select item explicitly, nulls first when descending", () => {
    expect(
      compile({
        select: ["id", "total"],
        orderBy: [{ total: "desc" }, { id: "asc" }],
      }).sql
    ).toBe(
      "select [t0].[id] as [c0], cast([t0].[total] as varchar(48)) as [c1] from [shop].[orders] as [t0]" +
        ` order by ${by("[t0].[total]", "desc")}, ${by("[t0].[id]")}${tail()}`
    );
  });

  it("orders by a column that is not selected", () => {
    expect(compile({ orderBy: [{ notes: "desc" }] }).sql).toBe(
      "select [t0].[id] as [c0] from [shop].[orders] as [t0]" +
        ` order by ${by("[t0].[notes]", "desc")}${tail()}`
    );
  });

  it("pages a query with nothing to order by in an order of no columns", () => {
    expect(compile({ from: "customers", select: ["prefs"] })).toEqual({
      sql:
        "select [t0].[prefs] as [c0] from [shop].[customers] as [t0]" +
        ` order by (select null)${tail()}`,
      parameters: PAGE,
    });
  });
});

describe("compileSql on SQL Server: joins", () => {
  it("joins inner by default", () => {
    expect(
      compile({ join: ["customer"], select: ["customer.region"] }).sql
    ).toBe(
      "select [t1].[region] as [c0] from [shop].[orders] as [t0]" +
        " inner join [shop].[customers] as [t1] on [t0].[customer_id] = [t1].[id]" +
        ` order by ${by("[t1].[region]")}${tail()}`
    );
  });

  it("joins left", () => {
    expect(
      compile({
        join: [{ relation: "lines", type: "left" }],
        select: ["lines.sku"],
      }).sql
    ).toBe(
      "select [t1].[sku] as [c0] from [shop].[orders] as [t0]" +
        " left join [shop].[order_lines] as [t1] on [t0].[id] = [t1].[order_id]" +
        ` order by ${by("[t1].[sku]")}${tail()}`
    );
  });

  it("joins a two-step path from the first join", () => {
    expect(
      compile({
        join: ["customer", "customer.account"],
        select: ["customer.account.plan"],
      }).sql
    ).toBe(
      "select [t2].[plan] as [c0] from [shop].[orders] as [t0]" +
        " inner join [shop].[customers] as [t1] on [t0].[customer_id] = [t1].[id]" +
        " inner join [shop].[accounts] as [t2] on [t1].[account_id] = [t2].[id]" +
        ` order by ${by("[t2].[plan]")}${tail()}`
    );
  });
});

describe("compileSql on SQL Server: aggregates and buckets", () => {
  it("refuses * for any aggregate but count", () => {
    expect(() => mssqlDialect.aggregate("sum", "*")).toThrow(
      "sum cannot take *"
    );
  });

  it.each([
    ["count(*)", { count: "*" }, "count_big(*)", "count_big(*)"],
    [
      "count of a column",
      { count: "notes" },
      "count_big([t0].[notes])",
      "count_big([t0].[notes])",
    ],
    [
      "countDistinct",
      { countDistinct: "status" },
      "count_big(distinct [t0].[status])",
      "count_big(distinct [t0].[status])",
    ],
    [
      "sum of a decimal, returned as text",
      { sum: "total" },
      "cast(sum([t0].[total]) as varchar(48))",
      "sum([t0].[total])",
    ],
    [
      "sum of a 64-bit integer, exact in decimal(38,0) and returned as text",
      { sum: "id" },
      "cast(sum(cast([t0].[id] as decimal(38,0))) as varchar(48))",
      "sum(cast([t0].[id] as decimal(38,0)))",
    ],
    [
      "sum of a 32-bit integer, in bigint",
      { sum: "customer_id" },
      "sum(cast([t0].[customer_id] as bigint))",
      "sum(cast([t0].[customer_id] as bigint))",
    ],
    [
      "avg of a decimal: the exact sum, as float, over the count",
      { avg: "total" },
      "cast(sum([t0].[total]) as float) / nullif(count_big([t0].[total]), 0)",
      "cast(sum([t0].[total]) as float) / nullif(count_big([t0].[total]), 0)",
    ],
    [
      "avg of an integer",
      { avg: "customer_id" },
      "cast(sum(cast([t0].[customer_id] as bigint)) as float) / nullif(count_big([t0].[customer_id]), 0)",
      "cast(sum(cast([t0].[customer_id] as bigint)) as float) / nullif(count_big([t0].[customer_id]), 0)",
    ],
    [
      "min of a decimal, returned as text",
      { min: "total" },
      "cast(min([t0].[total]) as varchar(48))",
      "min([t0].[total])",
    ],
    [
      "max of a timestamp",
      { max: "created_at" },
      "max([t0].[created_at])",
      "max([t0].[created_at])",
    ],
  ])("compiles %s", (_, item, selected, ordered) => {
    expect(compile({ select: [{ ...item, as: "a" }] })).toEqual({
      sql: `select ${selected} as [c0] from [shop].[orders] as [t0] order by ${by(ordered)}${tail()}`,
      parameters: PAGE,
    });
  });

  it("averages a float column in float", () => {
    const planned = plan({ select: [{ avg: "total", as: "a" }] });
    const item = planned.select[0]!;
    if (item.kind !== "aggregate" || item.column === "*") throw new Error();
    item.column.nativeType = "float";
    expect(
      compileSql(planned, mssqlDialect, { limit: 1001, offset: 0 }).sql
    ).toBe(
      "select avg(cast([t0].[total] as float)) as [c0] from [shop].[orders] as [t0]" +
        ` order by ${by("avg(cast([t0].[total] as float))")}${tail()}`
    );
  });

  it("sums a real column back into real, as Postgres does", () => {
    const planned = plan({ select: [{ sum: "total", as: "s" }] });
    const item = planned.select[0]!;
    if (item.kind !== "aggregate" || item.column === "*") throw new Error();
    item.column.nativeType = "real";
    expect(
      compileSql(planned, mssqlDialect, { limit: 1001, offset: 0 }).sql
    ).toBe(
      "select cast(sum([t0].[total]) as real) as [c0] from [shop].[orders] as [t0]" +
        ` order by ${by("cast(sum([t0].[total]) as real)")}${tail()}`
    );
  });

  it("returns money as text with its four decimal places", () => {
    const planned = plan({
      select: ["total", { sum: "total", as: "s" }],
      groupBy: ["total"],
    });
    for (const item of planned.select) {
      if (item.kind === "bucket" || item.column === "*") throw new Error();
      item.column.nativeType = "money";
    }
    expect(
      compileSql(planned, mssqlDialect, { limit: 1001, offset: 0 }).sql
    ).toContain(
      "select convert(varchar(48), [t0].[total], 2) as [c0], convert(varchar(48), sum([t0].[total]), 2) as [c1]"
    );
  });

  it.each([
    ["day", "day"],
    ["week", "iso_week"],
    ["month", "month"],
    ["quarter", "quarter"],
    ["year", "year"],
  ])(
    "truncates a datetimeoffset to the %s in UTC, with the unit written as a keyword",
    (unit, part) => {
      const bucket = `cast(datetrunc(${part}, switchoffset([t0].[created_at], '+00:00')) as datetime2(3))`;
      expect(
        compile({ select: [{ bucket: unit, column: "created_at", as: "b" }] })
      ).toEqual({
        sql: `select ${bucket} as [c0] from [shop].[orders] as [t0] order by ${by(bucket)}${tail()}`,
        parameters: PAGE,
      });
    }
  );

  it.each(["datetime2(3)", "datetime", "smalldatetime"])(
    "truncates a naive %s column as UTC as it is",
    (nativeType) => {
      const planned = plan({
        select: [{ bucket: "month", column: "created_at", as: "m" }],
      });
      const item = planned.select[0]!;
      if (item.kind !== "bucket") throw new Error();
      item.column.nativeType = nativeType;
      expect(
        compileSql(planned, mssqlDialect, { limit: 1001, offset: 0 }).sql
      ).toBe(
        "select cast(datetrunc(month, [t0].[created_at]) as datetime2(3)) as [c0] from [shop].[orders] as [t0]" +
          ` order by ${by("cast(datetrunc(month, [t0].[created_at]) as datetime2(3))")}${tail()}`
      );
    }
  );

  it("truncates a date to a date", () => {
    expect(
      compile({ select: [{ bucket: "week", column: "ordered_on", as: "w" }] })
        .sql
    ).toBe(
      "select cast(datetrunc(iso_week, [t0].[ordered_on]) as date) as [c0] from [shop].[orders] as [t0]" +
        ` order by ${by("cast(datetrunc(iso_week, [t0].[ordered_on]) as date)")}${tail()}`
    );
  });

  it("groups by the repeated expressions, which hold no parameter, and filters groups with having", () => {
    const month = `cast(datetrunc(month, switchoffset([t0].[created_at], '+00:00')) as datetime2(3))`;
    expect(
      compile({
        select: [
          "status",
          { bucket: "month", column: "created_at", as: "month" },
          { sum: "total", as: "revenue" },
          { count: "*", as: "n" },
        ],
        groupBy: ["status", "month"],
        having: { and: [{ revenue: { gt: 1000 } }, { n: { gte: 2 } }] },
        orderBy: [{ revenue: "desc" }],
      })
    ).toEqual({
      sql:
        `select [t0].[status] as [c0], ${month} as [c1],` +
        " cast(sum([t0].[total]) as varchar(48)) as [c2], count_big(*) as [c3] from [shop].[orders] as [t0]" +
        ` group by [t0].[status], ${month} having (sum([t0].[total]) > @1 and count_big(*) >= @2)` +
        ` order by ${by("sum([t0].[total])", "desc")}${tail(2)}`,
      parameters: [bigint("1000"), bigint("2"), ...PAGE],
    });
  });

  it("aggregates over all rows with no group by", () => {
    expect(compile({ select: [{ count: "*", as: "n" }] }).sql).toBe(
      "select count_big(*) as [c0] from [shop].[orders] as [t0]" +
        ` order by ${by("count_big(*)")}${tail()}`
    );
  });

  it("casts a decimal compared with an aggregate to a decimal of its own scale, binding an integer as bigint", () => {
    const sums = (value: number | string) =>
      compile({
        select: [{ sum: "quantity", as: "q" }],
        from: "order_lines",
        having: { q: { gt: value } },
      });
    const head =
      "select sum(cast([t0].[quantity] as bigint)) as [c0] from [shop].[order_lines] as [t0]" +
      " having sum(cast([t0].[quantity] as bigint)) > ";
    const order = ` order by ${by("sum(cast([t0].[quantity] as bigint))")}${tail(1)}`;
    expect(sums(10)).toEqual({
      sql: `${head}@1${order}`,
      parameters: [bigint("10"), ...PAGE],
    });
    expect(sums("10.5")).toEqual({
      sql: `${head}cast(@1 as decimal(38, 1))${order}`,
      parameters: [nvarchar("10.5"), ...PAGE],
    });
  });
});

describe("compileSql on SQL Server: filters", () => {
  const where = (filter: object, select = ["id"]) =>
    compile({ select, where: filter });
  const base = "select [t0].[id] as [c0] from [shop].[orders] as [t0] where ";
  const order = (used: number) => ` order by ${by("[t0].[id]")}${tail(used)}`;

  it.each([
    [
      "eq",
      { status: { eq: "paid" } },
      "[t0].[status] = @1",
      [nvarchar("paid")],
    ],
    [
      "ne",
      { status: { ne: "paid" } },
      "[t0].[status] <> @1",
      [nvarchar("paid")],
    ],
    ["gt", { id: { gt: 5 } }, "[t0].[id] > @1", [bigint("5")]],
    ["gte", { id: { gte: 5 } }, "[t0].[id] >= @1", [bigint("5")]],
    ["lt", { id: { lt: 5 } }, "[t0].[id] < @1", [bigint("5")]],
    ["lte", { id: { lte: 5 } }, "[t0].[id] <= @1", [bigint("5")]],
    [
      "between",
      { id: { between: [5, 9] } },
      "[t0].[id] between @1 and @2",
      [bigint("5"), bigint("9")],
    ],
    [
      "in",
      { status: { in: ["paid", "shipped"] } },
      "[t0].[status] in (@1, @2)",
      [nvarchar("paid"), nvarchar("shipped")],
    ],
    [
      "notIn",
      { status: { notIn: ["paid", "shipped"] } },
      "[t0].[status] not in (@1, @2)",
      [nvarchar("paid"), nvarchar("shipped")],
    ],
    ["isNull true", { notes: { isNull: true } }, "[t0].[notes] is null", []],
    [
      "isNull false",
      { notes: { isNull: false } },
      "[t0].[notes] is not null",
      [],
    ],
  ])("%s", (_name, filter, expected, parameters) => {
    expect(where(filter)).toEqual({
      sql: `${base}${expected}${order(parameters.length)}`,
      parameters: [...parameters, ...PAGE],
    });
  });

  it("contains lowers both sides and binds one pattern with \\, %, _ and [ escaped", () => {
    const c = where({ notes: { contains: "50%_off\\[x]" } });
    expect(c.sql).toBe(
      `${base}lower([t0].[notes]) like lower(@1) escape '\\'${order(1)}`
    );
    expect(c.parameters).toEqual([nvarchar("%50\\%\\_off\\\\\\[x]%"), ...PAGE]);
  });

  it("startsWith anchors the escaped pattern at the start", () => {
    expect(where({ notes: { startsWith: "a_b[" } }).parameters[0]).toEqual(
      nvarchar("a\\_b\\[%")
    );
  });

  it("combines and, or and not with parentheses", () => {
    const c = where({
      and: [
        { status: { eq: "paid" } },
        { or: [{ id: { lt: 3 } }, { not: { notes: { isNull: true } } }] },
      ],
    });
    expect(c.sql).toBe(
      `${base}([t0].[status] = @1 and ([t0].[id] < @2 or not ([t0].[notes] is null)))${order(2)}`
    );
    expect(c.parameters).toEqual([nvarchar("paid"), bigint("3"), ...PAGE]);
  });

  it("filters on a joined column", () => {
    expect(
      compile({
        join: ["customer"],
        where: { "customer.region": { eq: "emea" } },
      })
    ).toEqual({
      sql:
        "select [t0].[id] as [c0] from [shop].[orders] as [t0]" +
        " inner join [shop].[customers] as [t1] on [t0].[customer_id] = [t1].[id]" +
        ` where [t1].[region] = @1${order(1)}`,
      parameters: [nvarchar("emea"), ...PAGE],
    });
  });

  it("casts a timestamp to datetimeoffset for a datetimeoffset column", () => {
    expect(where({ created_at: { gte: "2026-01-01T00:00:00+02:00" } })).toEqual(
      {
        sql: `${base}[t0].[created_at] >= cast(@1 as datetimeoffset)${order(1)}`,
        parameters: [nvarchar("2026-01-01T00:00:00+02:00"), ...PAGE],
      }
    );
  });

  it.each([
    ["datetime2(3)", "datetime2(7)"],
    ["smalldatetime", "datetime2(7)"],
    ["datetime", "datetime"],
  ])(
    "converts the timestamp to naive UTC on the parameter side for a %s column, as %s",
    (nativeType, target) => {
      const planned = plan({
        where: { created_at: { gte: "2026-01-01T00:00:00+02:00" } },
      });
      const filter = planned.where;
      if (filter?.kind !== "compare") throw new Error("expected a comparison");
      filter.subject.nativeType = nativeType;
      expect(
        compileSql(planned, mssqlDialect, { limit: 1001, offset: 0 })
      ).toEqual({
        sql: `${base}[t0].[created_at] >= cast(switchoffset(cast(@1 as datetimeoffset), '+00:00') as ${target})${order(1)}`,
        parameters: [nvarchar("2026-01-01T00:00:00+02:00"), ...PAGE],
      });
    }
  );

  it("cuts a timestamp's fraction to SQL Server's seven digits, never rounding it", () => {
    expect(
      where({
        created_at: {
          between: [
            "2026-03-31T23:59:59.99999999Z",
            "2026-04-01T00:00:00.123456789+02:00",
          ],
        },
      }).parameters.slice(0, 2)
    ).toEqual([
      nvarchar("2026-03-31T23:59:59.9999999Z"),
      nvarchar("2026-04-01T00:00:00.1234567+02:00"),
    ]);
    expect(
      where({ created_at: { eq: "2026-03-31T23:59:59.1234567Z" } })
        .parameters[0]
    ).toEqual(nvarchar("2026-03-31T23:59:59.1234567Z"));
  });

  it.each(["text", "ntext", "xml"])(
    "reads a %s column as nvarchar(max) wherever it is used",
    (nativeType) => {
      const planned = plan({
        from: "customers",
        select: ["name"],
        where: { name: { contains: "a" } },
        orderBy: [{ name: "desc" }],
      });
      for (const ref of [
        planned.select[0]!.kind === "column" ? planned.select[0]!.column : null,
        planned.where?.kind === "match" ? planned.where.subject : null,
      ]) {
        if (ref) ref.nativeType = nativeType;
      }
      const name = "cast([t0].[name] as nvarchar(max))";
      expect(
        compileSql(planned, mssqlDialect, { limit: 1001, offset: 0 }).sql
      ).toBe(
        `select ${name} as [c0] from [shop].[customers] as [t0]` +
          ` where lower(${name}) like lower(@1) escape '\\'` +
          ` order by ${by(name, "desc")}${tail(1)}`
      );
    }
  );

  it("casts a date to date", () => {
    expect(
      where({ ordered_on: { between: ["2026-01-01", "2026-02-01"] } })
    ).toEqual({
      sql: `${base}[t0].[ordered_on] between cast(@1 as date) and cast(@2 as date)${order(2)}`,
      parameters: [nvarchar("2026-01-01"), nvarchar("2026-02-01"), ...PAGE],
    });
  });

  it("binds an integer as bigint and a decimal as text cast to a decimal of its own scale", () => {
    expect(where({ total: { in: [1, "2.50", 0.1] } })).toEqual({
      sql: `${base}[t0].[total] in (@1, cast(@2 as decimal(38, 2)), cast(@3 as decimal(38, 1)))${order(3)}`,
      parameters: [bigint("1"), nvarchar("2.50"), nvarchar("0.1"), ...PAGE],
    });
  });

  it("binds an integer past bigint as a decimal, and a number no decimal holds as a float", () => {
    expect(
      where({
        id: { in: [2147483648, "9223372036854775807", "9223372036854775808"] },
      })
    ).toEqual({
      sql: `${base}[t0].[id] in (@1, @2, cast(@3 as decimal(38, 0)))${order(3)}`,
      parameters: [
        bigint("2147483648"),
        bigint("9223372036854775807"),
        nvarchar("9223372036854775808"),
        ...PAGE,
      ],
    });
    expect(where({ total: { in: [1e300, 1e-7] } })).toEqual({
      sql: `${base}[t0].[total] in (@1, @2)${order(2)}`,
      parameters: [
        { type: "float", value: 1e300 },
        { type: "float", value: 1e-7 },
        ...PAGE,
      ],
    });
  });

  it("compares booleans as bit parameters", () => {
    expect(
      compile({
        from: "customers",
        select: ["id"],
        where: { vip: { eq: true } },
      })
    ).toEqual({
      sql: `select [t0].[id] as [c0] from [shop].[customers] as [t0] where [t0].[vip] = @1${order(1)}`,
      parameters: [{ type: "bit", value: true }, ...PAGE],
    });
  });
});

describe("compileSql on SQL Server: the parameter limit", () => {
  const ids = (from: number) =>
    Array.from({ length: 1000 }, (_, i) => from + i);
  const filters = (lists: number, extra: number) => ({
    or: [
      ...Array.from({ length: lists }, (_, j) => ({
        id: { in: ids(j * 1000) },
      })),
      ...(extra > 0 ? [{ id: { in: ids(100_000).slice(0, extra) } }] : []),
    ],
  });

  it("binds 2,098 parameters, paging included", () => {
    expect(compile({ where: filters(2, 96) }).parameters).toHaveLength(2098);
  });

  it("refuses a query that binds more, before it runs, naming the limit", () => {
    let thrown: unknown;
    try {
      compile({ where: filters(2, 97) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QueryError);
    expect(thrown).toMatchObject({
      statusCode: 422,
      code: "too_many_parameters",
      path: [],
      suggestions: [],
    });
    expect((thrown as Error).message).toBe(
      "The query binds 2099 values; this source takes at most 2098 in one query, paging included"
    );
  });
});

describe("compileSql on SQL Server: without the default order", () => {
  const unordered = (query: object, fetch = { limit: 1001, offset: 0 }) =>
    compileSql(plan(query), mssqlDialect, { ...fetch, defaultOrder: false });

  it("pages a query with no orderBy in an order of no columns, keeping every parameter", () => {
    expect(
      unordered(
        {
          select: ["id", "status"],
          where: { status: { eq: "paid" } },
        },
        { limit: 11, offset: 20 }
      )
    ).toEqual({
      sql:
        "select [t0].[id] as [c0], [t0].[status] as [c1] from [shop].[orders] as [t0]" +
        " where [t0].[status] = @1" +
        " order by (select null) offset @2 rows fetch next @3 rows only",
      parameters: [nvarchar("paid"), bigint("20"), bigint("11")],
    });
  });

  it("adds no sort key to a distinct or grouped query with no orderBy", () => {
    expect(unordered({ select: ["status", "id"], distinct: true }).sql).toBe(
      "select [t0].[status] as [c0], [t0].[id] as [c1] from [shop].[orders] as [t0]" +
        " group by [t0].[status], [t0].[id]" +
        ` order by (select null)${tail()}`
    );
    expect(
      unordered({
        select: ["status", { count: "*", as: "n" }],
        groupBy: ["status"],
      }).sql
    ).toBe(
      "select [t0].[status] as [c0], count_big(*) as [c1] from [shop].[orders] as [t0]" +
        " group by [t0].[status]" +
        ` order by (select null)${tail()}`
    );
  });

  it("compiles a query with its own orderBy exactly as with the default order", () => {
    const queries = [
      { select: ["id", "total"], orderBy: [{ total: "desc" }, { id: "asc" }] },
      { orderBy: [{ notes: "desc" }] },
      { select: ["id", "status"], orderBy: [{ status: "asc" }] },
      {
        select: ["status", { sum: "total", as: "revenue" }],
        groupBy: ["status"],
        orderBy: [{ revenue: "desc" }],
      },
    ];
    for (const query of queries) {
      expect(unordered(query, { limit: 11, offset: 20 })).toEqual(
        compile(query, { limit: 11, offset: 20 })
      );
    }
  });

  it("leaves out an orderBy identical to the default order, which the plan cannot tell from it", () => {
    expect(unordered({ orderBy: [{ id: "asc" }] }).sql).toBe(
      "select [t0].[id] as [c0] from [shop].[orders] as [t0]" +
        ` order by (select null)${tail()}`
    );
  });

  it("orders by every select item when defaultOrder is true or unset", () => {
    const query = { select: ["id", "status"] };
    const today = compile(query);
    expect(today.sql).toContain(
      ` order by ${by("[t0].[id]")}, ${by("[t0].[status]")}`
    );
    expect(
      compileSql(plan(query), mssqlDialect, {
        limit: 1001,
        offset: 0,
        defaultOrder: true,
      })
    ).toEqual(today);
  });
});
