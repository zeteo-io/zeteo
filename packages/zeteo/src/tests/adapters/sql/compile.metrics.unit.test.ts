// @module-tag unit
// @module-tag platform
import { measure, metricsCatalog } from "../../support/pure/metricsCatalog.js";
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { sqlLanguage } from "../../../adapters/sql/language.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { describe, expect, it } from "vitest";

// A metric query compiles to one aggregate subquery per part, unioned with
// each part's value in its own column, pivoted by period with max, and the
// formulas computed over the pivoted values.

const NOW = new Date("2026-06-15T12:00:00Z");

const compileOn =
  (dialect: SqlDialect) =>
  (
    query: object,
    fetch: { limit: number; offset: number; defaultOrder?: boolean } = {
      limit: 101,
      offset: 0,
    }
  ) =>
    compileSql(
      sqlLanguage.plan(
        sqlLanguage.schema.parse({ source: "shop", ...query }),
        metricsCatalog({ engine: dialect.name }),
        { now: NOW }
      ),
      dialect,
      fetch
    );
const pg = compileOn(postgresDialect);
const ms = compileOn(mssqlDialect);

const nvarchar = (value: string) => ({ type: "nvarchar", value });
const bigint = (value: string) => ({ type: "bigint", value });

const ROAS_BY_MONTH = {
  metrics: ["roas", "revenue"],
  bucket: "month",
  range: { gte: { date: "2026-01-01" }, lt: { date: "2026-07-01" } },
};

describe("compileSql: a metric query on Postgres", () => {
  it("unions one aggregate per part, pivots by period and divides the pivoted values", () => {
    expect(pg(ROAS_BY_MONTH)).toEqual({
      sql:
        'select "u"."period" as "c0",' +
        ' round(cast(max("u"."v0") as numeric(38, 18)) / nullif(cast(max("u"."v1") as numeric(38, 10)), 0), 6) as "c1",' +
        ' max("u"."v0") as "c2"' +
        ' from (select date_trunc($1, "t0"."ordered_on")::date as "period", sum("t0"."total") as "v0", cast(null as numeric) as "v1"' +
        ' from "shop"."orders" as "t0" where ("t0"."ordered_on" >= $2 and "t0"."ordered_on" < $3) group by 1' +
        ' union all select date_trunc($4, "t0"."launched_on")::date as "period", cast(null as numeric) as "v0", sum("t0"."cost") as "v1"' +
        ' from "shop"."products" as "t0" where ("t0"."launched_on" >= $5 and "t0"."launched_on" < $6) group by 1) as "u"' +
        ' group by 1 order by "c0" asc nulls last limit $7 offset $8',
      parameters: [
        "month",
        "2026-01-01",
        "2026-07-01",
        "month",
        "2026-01-01",
        "2026-07-01",
        101,
        0,
      ],
    });
  });

  it("without a bucket groups nothing, so the pivot is one row", () => {
    const { sql } = pg({ metrics: ["roas"] });
    expect(sql).toBe(
      'select round(cast(max("u"."v0") as numeric(38, 18)) / nullif(cast(max("u"."v1") as numeric(38, 10)), 0), 6) as "c0"' +
        ' from (select sum("t0"."total") as "v0", cast(null as numeric) as "v1" from "shop"."orders" as "t0"' +
        ' union all select cast(null as numeric) as "v0", sum("t0"."cost") as "v1" from "shop"."products" as "t0") as "u"' +
        " limit $1 offset $2"
    );
  });

  it("reads a fixed measure as a scalar subquery in the outer select, and fixed measures alone from no table", () => {
    const { sql, parameters } = pg({ metrics: ["landing"] });
    expect(sql).toContain(
      '(max("u"."v0") + ((select max("f1_t0"."balance") as "v" from "billing"."accounts" as "f1_t0") * cast($1 as bigint))) as "c0"'
    );
    expect(parameters[0]).toBe("22");
    expect(pg({ metrics: ["top_balance"] }).sql).toBe(
      'select (select max("f1_t0"."balance") as "v" from "billing"."accounts" as "f1_t0") as "c0" limit $1 offset $2'
    );
  });

  it("reads date buckets as timestamps beside timestamp ones, and joins a part's date column", () => {
    const mixed = pg({ metrics: ["revenue", "revenue_at"], bucket: "month" });
    expect(mixed.sql).toContain(
      'select cast(date_trunc($1, "t0"."ordered_on")::date as timestamp) as "period"'
    );
    expect(mixed.sql).toContain(
      'select date_trunc($2, "t0"."created_at") as "period"'
    );
    expect(pg({ metrics: ["line_value"], bucket: "day" }).sql).toContain(
      'from "shop"."order_lines" as "t0" left join "shop"."products" as "t1" on "t0"."product_id" = "t1"."id" group by 1'
    );
  });

  it("orders as asked, or not at all when the default order is not wanted", () => {
    expect(
      pg({ ...ROAS_BY_MONTH, orderBy: [{ roas: "desc" }, { period: "asc" }] })
        .sql
    ).toMatch(/ order by "c1" desc nulls first, "c0" asc nulls last limit/);
    expect(
      pg(ROAS_BY_MONTH, { limit: 10, offset: 0, defaultOrder: false }).sql
    ).not.toMatch(/order by/);
  });

  it("binds a timestamp bound as a timestamptz", () => {
    const { sql, parameters } = pg({
      metrics: ["revenue_at"],
      range: { gte: { timestamp: "2026-03-01T00:00:00Z" } },
    });
    expect(sql).toContain('where "t0"."created_at" >= cast($1 as timestamptz)');
    expect(parameters[0]).toBe("2026-03-01T00:00:00Z");
  });
});

describe("compileSql: three or more parts", () => {
  const THREE = { metrics: ["revenue", "spend", "signups"], bucket: "month" };

  it("types every other part's null on Postgres, so the union's columns never resolve to text", () => {
    const { sql } = pg(THREE);
    const branches = sql.slice(sql.indexOf(" from (") + 7).split(" union all ");
    expect(branches).toHaveLength(3);
    expect(branches[0]).toContain(
      'sum("t0"."total") as "v0", cast(null as numeric) as "v1", cast(null as numeric) as "v2"'
    );
    expect(branches[1]).toContain(
      'cast(null as numeric) as "v0", sum("t0"."cost") as "v1", cast(null as numeric) as "v2"'
    );
    expect(branches[2]).toContain(
      'cast(null as numeric) as "v0", cast(null as numeric) as "v1", count(*) as "v2"'
    );
    expect(sql).toContain('max("u"."v2") as "c3"');
  });

  it("types a float part's nulls as float8 on Postgres", () => {
    const { sql } = compileSql(
      sqlLanguage.plan(
        sqlLanguage.schema.parse({
          source: "shop",
          metrics: ["revenue", "spend", "avg_order"],
        }),
        metricsCatalog(
          {},
          {
            measures: [
              measure(
                "avg_order",
                { avg: "total" },
                { dateColumn: "ordered_on" }
              ),
            ],
          }
        ),
        { now: NOW }
      ),
      postgresDialect,
      { limit: 101, offset: 0 }
    );
    expect(sql).toContain(
      'sum("t0"."total") as "v0", cast(null as numeric) as "v1", cast(null as float8) as "v2"'
    );
  });

  it("leaves SQL Server's nulls bare: it types a union's column over all branches", () => {
    const { sql } = ms(THREE);
    expect(sql.split(" union all ")).toHaveLength(3);
    expect(sql).toContain("null as [v0], null as [v1], count_big(*) as [v2]");
  });
});

describe("compileSql: a metric query on SQL Server", () => {
  it("unions one aggregate per part, pivots by period and returns decimals as text", () => {
    expect(ms(ROAS_BY_MONTH)).toEqual({
      sql:
        "select [u].[period] as [c0]," +
        " cast(cast(round(cast(max([u].[v0]) as decimal(38, 18)) / nullif(cast(max([u].[v1]) as decimal(38, 10)), 0), 6) as decimal(38, 6)) as varchar(48)) as [c1]," +
        " cast(max([u].[v0]) as varchar(48)) as [c2]" +
        " from (select cast(datetrunc(month, [t0].[ordered_on]) as date) as [period], sum([t0].[total]) as [v0], null as [v1]" +
        " from [shop].[orders] as [t0] where ([t0].[ordered_on] >= cast(@1 as date) and [t0].[ordered_on] < cast(@2 as date))" +
        " group by cast(datetrunc(month, [t0].[ordered_on]) as date)" +
        " union all select cast(datetrunc(month, [t0].[launched_on]) as date) as [period], null as [v0], sum([t0].[cost]) as [v1]" +
        " from [shop].[products] as [t0] where ([t0].[launched_on] >= cast(@3 as date) and [t0].[launched_on] < cast(@4 as date))" +
        " group by cast(datetrunc(month, [t0].[launched_on]) as date)) as [u]" +
        " group by [u].[period]" +
        " order by case when [u].[period] is null then 1 else 0 end, [u].[period] asc" +
        " offset @5 rows fetch next @6 rows only",
      parameters: [
        nvarchar("2026-01-01"),
        nvarchar("2026-07-01"),
        nvarchar("2026-01-01"),
        nvarchar("2026-07-01"),
        bigint("0"),
        bigint("101"),
      ],
    });
  });

  it("reads fixed measures alone from no table, ordered by nothing to page", () => {
    expect(ms({ metrics: ["top_balance"] }).sql).toBe(
      "select cast((select max([f1_t0].[balance]) as [v] from [billing].[accounts] as [f1_t0]) as varchar(48)) as [c0]" +
        " order by (select null) offset @1 rows fetch next @2 rows only"
    );
  });

  it("reads date buckets as datetime2 beside a datetimeoffset's UTC bucket", () => {
    const { sql } = ms({
      metrics: ["revenue", "revenue_at"],
      bucket: "quarter",
    });
    expect(sql).toContain(
      "select cast(cast(datetrunc(quarter, [t0].[ordered_on]) as date) as datetime2(3)) as [period]"
    );
    expect(sql).toContain(
      "select cast(datetrunc(quarter, switchoffset([t0].[created_at], '+00:00')) as datetime2(3)) as [period]"
    );
  });

  it("keeps a count's integer kind through the pivot: no decimal cast", () => {
    expect(ms({ metrics: ["signups"] }).sql).toBe(
      "select max([u].[v0]) as [c0] from (select count_big(*) as [v0] from [shop].[customers] as [t0]) as [u]" +
        " order by (select null) offset @1 rows fetch next @2 rows only"
    );
  });
});
