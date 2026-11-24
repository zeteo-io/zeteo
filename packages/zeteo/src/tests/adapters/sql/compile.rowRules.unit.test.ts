// @module-tag unit
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import type { RowRule, RuleColumn } from "../../../row-rules/resolve.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { metricsCatalog } from "../../support/pure/metricsCatalog.js";
import type { ShopOptions } from "../../support/pure/shopCatalog.js";
import type { QueryableType } from "../../../adapters/sql/types.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { sqlLanguage } from "../../../adapters/sql/language.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { measure } from "../../support/pure/metricsCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// A table with a row rule is read, wherever it is read, through what keeps the
// caller's expressions off the rows the rule leaves out: a MATERIALIZED WITH
// query inside its derived table on Postgres, a temp table copied by a
// statement of its own on SQL Server. Its values are bound like any filter's.

const NOW = new Date("2026-06-15T12:00:00Z");

const ruleColumn = (
  id: string,
  type: QueryableType,
  nativeType: string
): RuleColumn => ({ id, name: id.split(".")[1]!, type, nativeType });

const rule = (
  filter: Record<string, unknown>,
  columns: RuleColumn[]
): RowRule =>
  ({
    kind: "filter",
    filter,
    columns: new Map(columns.map((c) => [c.id, c])),
    descriptions: [],
  }) as RowRule;

/** Rules as each engine's catalogue gives their columns' type names. */
const rules = (text: string) => ({
  PAID: rule({ "orders.status": { in: ["paid"] } }, [
    ruleColumn("orders.status", "text", text),
  ]),
  EU: rule({ "customers.region": { eq: "EU" } }, [
    ruleColumn("customers.region", "text", text),
  ]),
});

const compileOn =
  (dialect: SqlDialect) =>
  (query: object, options: ShopOptions = {}, metrics = false) =>
    compileSql(
      sqlLanguage.plan(
        sqlLanguage.schema.parse({ source: "shop", ...query }),
        (metrics ? metricsCatalog : shopCatalog)({
          engine: dialect.name,
          ...options,
        }),
        { now: NOW }
      ),
      dialect,
      { limit: 101, offset: 0 }
    );
const pg = compileOn(postgresDialect);
const ms = compileOn(mssqlDialect);

describe("compileSql: row rules on Postgres", () => {
  const { PAID, EU } = rules("text");

  it("reads the from table through its rule", () => {
    expect(
      pg({ from: "orders", select: ["id"] }, { rowRules: { orders: PAID } })
    ).toEqual({
      sql:
        'select "t0"."id" as "c0" from (with "r" as materialized (select * from "shop"."orders" where "status" in ($1)) select * from "r") as "t0"' +
        ' order by "c0" asc nulls last limit $2 offset $3',
      parameters: ["paid", 101, 0],
    });
  });

  it("reads a joined table through its rule, left or inner", () => {
    for (const type of ["left", "inner"]) {
      const { sql, parameters } = pg(
        {
          from: "orders",
          join: [{ relation: "customer", type }],
          select: ["id", "customer.name"],
        },
        { rowRules: { customers: EU } }
      );
      expect(sql).toContain(
        `from "shop"."orders" as "t0" ${type} join (with "r" as materialized (select * from "shop"."customers" where "region" = $1) select * from "r") as "t1" on "t0"."customer_id" = "t1"."id"`
      );
      expect(parameters[0]).toBe("EU");
    }
  });

  it("compiles a rule that keeps no row to 1 = 0", () => {
    const { sql } = pg(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: { kind: "never" } } }
    );
    expect(sql).toContain(
      'from (with "r" as materialized (select * from "shop"."orders" where 1 = 0) select * from "r") as "t0"'
    );
  });

  it("binds 5,000 values as one array", () => {
    const values = Array.from({ length: 5000 }, (_, i) => String(i + 1));
    const big = rule({ "orders.customer_id": { in: values } }, [
      ruleColumn("orders.customer_id", "number", "integer"),
    ]);
    const { sql, parameters } = pg(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: big } }
    );
    expect(sql).toContain(
      'from (with "r" as materialized (select * from "shop"."orders" where "customer_id" = any($1)) select * from "r") as "t0"'
    );
    expect(parameters).toEqual([values, 101, 0]);
  });

  it("binds a long notIn as one array, cast where the column needs it", () => {
    const values = Array.from(
      { length: 101 },
      (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`
    );
    const big = rule({ "orders.created_at": { notIn: values } }, [
      ruleColumn("orders.created_at", "timestamp", "timestamp with time zone"),
    ]);
    const { sql, parameters } = pg(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: big } }
    );
    expect(sql).toContain(
      'where "created_at" <> all(cast($1 as timestamptz[]))'
    );
    expect(parameters[0]).toEqual(values);
  });

  it("reads a fixed measure's table through its rule", () => {
    const { sql } = pg(
      {
        from: "customers",
        select: ["name", { measure: "paid_count" }],
        groupBy: ["name"],
      },
      {
        measures: [measure("paid_count", { count: "*" }, { fixed: true })],
        rowRules: { orders: PAID },
      }
    );
    expect(sql).toContain(
      'from (with "r" as materialized (select * from "shop"."orders" where "status" in ($1)) select * from "r") as "f1_t0"'
    );
  });

  it("reads each metric part's table through its rule", () => {
    const { sql } = pg(
      { metrics: ["revenue"], bucket: "month" },
      { rowRules: { orders: PAID } },
      true
    );
    expect(sql).toContain(
      'from (with "r" as materialized (select * from "shop"."orders" where "status" in ($2)) select * from "r") as "t0"'
    );
  });
});

describe("compileSql: row rules on SQL Server", () => {
  const { PAID, EU } = rules("nvarchar(200)");

  it("reads the from table through its rule", () => {
    const { sql, parameters } = ms(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: PAID } }
    );
    expect(sql).toContain(
      "drop table if exists #r0; select * into #r0 from [shop].[orders] where [status] in (@1); select [t0].[id] as [c0] from #r0 as [t0]"
    );
    expect(parameters[0]).toEqual({ type: "nvarchar", value: "paid" });
  });

  it("reads a joined table through its rule, left or inner", () => {
    for (const type of ["left", "inner"]) {
      const { sql } = ms(
        {
          from: "orders",
          join: [{ relation: "customer", type }],
          select: ["id", "customer.name"],
        },
        { rowRules: { customers: EU } }
      );
      expect(sql).toContain(
        `drop table if exists #r0; select * into #r0 from [shop].[customers] where [region] = @1; select [t0].[id] as [c0], [t1].[name] as [c1] from [shop].[orders] as [t0] ${type} join #r0 as [t1] on [t0].[customer_id] = [t1].[id]`
      );
    }
  });

  it("compiles a rule that keeps no row to 1 = 0", () => {
    const { sql } = ms(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: { kind: "never" } } }
    );
    expect(sql).toContain(
      "select * into #r0 from [shop].[orders] where 1 = 0; select [t0].[id] as [c0] from #r0 as [t0]"
    );
  });

  it("binds 5,000 values as one JSON parameter read with openjson", () => {
    const values = Array.from({ length: 5000 }, (_, i) => String(i + 1));
    const big = rule({ "orders.customer_id": { in: values } }, [
      ruleColumn("orders.customer_id", "number", "int"),
    ]);
    const { sql, parameters } = ms(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: big } }
    );
    expect(sql).toContain(
      "select * into #r0 from [shop].[orders] where [customer_id] in (select cast([value] as bigint) from openjson(@1)); select [t0].[id] as [c0] from #r0 as [t0]"
    );
    expect(parameters).toHaveLength(3);
    expect(parameters[0]).toEqual({
      type: "nvarchar",
      value: JSON.stringify(values),
    });
  });

  it("copies each ruled table by a statement of its own, which holds nothing of the caller's, and numbers parameters across the batch", () => {
    const { sql, parameters } = ms(
      {
        from: "orders",
        join: [{ relation: "customer", type: "left" }],
        select: ["id", { calc: { mul: ["total", 1000] }, as: "p" }],
        where: { p: { gt: 5 } },
      },
      { rowRules: { orders: PAID, customers: EU } }
    );
    const statements = sql.split("; ");
    expect(statements.slice(0, 4)).toEqual([
      "drop table if exists #r0",
      "select * into #r0 from [shop].[orders] where [status] in (@1)",
      "drop table if exists #r1",
      "select * into #r1 from [shop].[customers] where [region] = @2",
    ]);
    const query = statements.slice(4).join("; ");
    expect(query).toMatch(/^select /);
    expect(query).toContain(
      "from #r0 as [t0] left join #r1 as [t1] on [t0].[customer_id] = [t1].[id]"
    );
    expect(query).not.toContain("[shop].");
    expect(query).toContain("@3");
    expect(parameters.slice(0, 2)).toEqual([
      { type: "nvarchar", value: "paid" },
      { type: "nvarchar", value: "EU" },
    ]);
  });

  it("reads each metric part's table through its rule", () => {
    const { sql } = ms(
      { metrics: ["revenue"], bucket: "month" },
      { rowRules: { orders: PAID } },
      true
    );
    expect(sql).toMatch(
      /^drop table if exists #r0; select \* into #r0 from \[shop\]\.\[orders\] where \[status\] in \(@1\); select .* from #r0 as \[t0\]/
    );
  });
});

describe("compileSql: a long in list", () => {
  const values = Array.from({ length: 150 }, (_, i) => i + 6);
  const inCase = {
    from: "orders",
    select: [
      "status",
      {
        sum: {
          case: {
            when: [{ if: { id: { in: values } }, then: "total" }],
            else: 0,
          },
        },
        as: "s",
      },
    ],
    groupBy: ["status"],
  };

  it("binds one list in where on both engines", () => {
    const where = {
      from: "orders",
      select: ["id"],
      where: { id: { in: values } },
    };
    expect(pg(where).parameters).toHaveLength(3);
    expect(ms(where).sql).toContain("openjson(@1)");
    expect(ms(where).parameters).toHaveLength(3);
  });

  it("keeps a value per parameter inside an aggregated case on SQL Server, which takes no subquery there", () => {
    const { sql, parameters } = ms(inCase);
    expect(sql).not.toContain("openjson");
    expect(sql).toContain("sum(case when [t0].[id] in (@1, @2,");
    expect(parameters.length).toBeGreaterThan(150);
  });

  it("binds one array inside an aggregated case on Postgres", () => {
    const { sql } = pg(inCase);
    expect(sql).toContain('sum(case when "t0"."id" = any($1)');
  });

  it("keeps a value per parameter in a measure's where on SQL Server", () => {
    const { sql } = ms(
      { from: "orders", select: [{ measure: "picked" }] },
      {
        measures: [
          measure(
            "picked",
            { sum: "total" },
            { where: { id: { in: values } } }
          ),
        ],
      }
    );
    expect(sql).not.toContain("openjson");
  });
});

describe("compile.ts", () => {
  it("names a table in SQL only inside tableSource", () => {
    const text = readFileSync(
      fileURLToPath(
        new URL("../../../adapters/sql/compile.ts", import.meta.url)
      ),
      "utf8"
    );
    const start = text.indexOf("const tableSource = ");
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\n};\n", start);
    const outside = text.slice(0, start) + text.slice(end);
    expect(outside).not.toMatch(/\btable\(/);
    expect(outside).not.toMatch(/schemaName/);
  });
});
