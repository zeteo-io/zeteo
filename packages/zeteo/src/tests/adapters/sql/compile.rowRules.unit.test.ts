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
        'select "t0"."id" as "c0" from (with "r" as materialized (select "id" from "shop"."orders" where "status" in ($1)) select * from "r") as "t0"' +
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
        `from "shop"."orders" as "t0" ${type} join (with "r" as materialized (select "id", "name" from "shop"."customers" where "region" = $1) select * from "r") as "t1" on "t0"."customer_id" = "t1"."id"`
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
      'from (with "r" as materialized (select "id" from "shop"."orders" where 1 = 0) select * from "r") as "t0"'
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
      'from (with "r" as materialized (select "id" from "shop"."orders" where "customer_id" = any($1)) select * from "r") as "t0"'
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
      // count(*) reads no column: the WITH query keeps none.
      'from (with "r" as materialized (select  from "shop"."orders" where "status" in ($1)) select * from "r") as "f1_t0"'
    );
  });

  it("reads each metric part's table through its rule", () => {
    const { sql } = pg(
      { metrics: ["revenue"], bucket: "month" },
      { rowRules: { orders: PAID } },
      true
    );
    expect(sql).toContain(
      'from (with "r" as materialized (select "ordered_on", "total" from "shop"."orders" where "status" in ($2)) select * from "r") as "t0"'
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
      "drop table if exists #r0; select [id] into #r0 from [shop].[orders] where [status] in (@5); select [t0].[id] as [c0] from #r0 as [t0]"
    );
    expect(parameters[4]).toEqual({ type: "nvarchar", value: "paid" });
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
        `drop table if exists #r0; select [id], [name] into #r0 from [shop].[customers] where [region] = @5; select [t0].[id] as [c0], [t1].[name] as [c1] from [shop].[orders] as [t0] ${type} join #r0 as [t1] on [t0].[customer_id] = [t1].[id]`
      );
    }
  });

  it("compiles a rule that keeps no row to 1 = 0", () => {
    const { sql } = ms(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: { kind: "never" } } }
    );
    expect(sql).toContain(
      "select [id] into #r0 from [shop].[orders] where 1 = 0; select [t0].[id] as [c0] from #r0 as [t0]"
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
      "select [id] into #r0 from [shop].[orders] where [customer_id] in (select cast([value] as bigint) from openjson(@5)); select [t0].[id] as [c0] from #r0 as [t0]"
    );
    // The guard's four, the list's and the page's two.
    expect(parameters).toHaveLength(7);
    expect(parameters[4]).toEqual({
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
    // Each copy after its guard, which binds its columns' names and types
    // and the table's schema and name.
    expect(statements[0]).toMatch(
      /^if exists \(select 1 from \(values \(@1, @2\)\) .*quotename\(@3\) \+ N'\.' \+ quotename\(@4\).* throw 51000, .*, 1$/
    );
    expect(statements[3]).toMatch(
      /^if exists \(select 1 from \(values \(@6, @7\)\) .*quotename\(@8\) \+ N'\.' \+ quotename\(@9\).* throw 51000, .*, 2$/
    );
    expect([1, 2, 4, 5].map((i) => statements[i])).toEqual([
      "drop table if exists #r0",
      "select [customer_id], [id], [total] into #r0 from [shop].[orders] where [status] in (@5)",
      "drop table if exists #r1",
      "select [id] into #r1 from [shop].[customers] where [region] = @10",
    ]);
    const query = statements.slice(6).join("; ");
    expect(query).toMatch(/^select /);
    expect(query).toContain(
      "from #r0 as [t0] left join #r1 as [t1] on [t0].[customer_id] = [t1].[id]"
    );
    expect(query).not.toContain("[shop].");
    expect(query).toContain("@11");
    expect([parameters[4], parameters[9]]).toEqual([
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
      /^if exists .*?; drop table if exists #r0; select \[ordered_on\], \[total\] into #r0 from \[shop\]\.\[orders\] where \[status\] in \(@5\); select .* from #r0 as \[t0\]/
    );
  });
});

// The catalogue says `customer_id` is int; the column may have been widened
// since it was read. A value past int may be left out only where that can
// only drop rows (eq, in); where it would add rows (ne, notIn, or eq and in
// under a not) it is compared exactly, and a value no SQL Server exact
// numeric holds makes a rule's condition keep no row.
describe("compileSql: values the catalogue's type cannot hold, on SQL Server", () => {
  const { PAID } = rules("nvarchar(200)");
  const PAST_INT = "3000000000";
  const HUGE = "1" + "0".repeat(38);
  const ruleOn = (filter: Record<string, unknown>) =>
    ms(
      { from: "orders", select: ["id"] },
      {
        rowRules: {
          orders: rule(filter, [
            ruleColumn("orders.customer_id", "number", "int"),
          ]),
        },
      }
    );
  const where = (sql: string) =>
    /from \[shop\]\.\[orders\] where (.*?); select/.exec(sql)![1];

  it("compares a value past int exactly in ne, notIn and a not around in or eq", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ "orders.customer_id": { ne: PAST_INT } }, "[customer_id] <> @5"],
      [
        { "orders.customer_id": { notIn: [PAST_INT, "2"] } },
        "[customer_id] not in (@5, @6)",
      ],
      [
        { not: { "orders.customer_id": { in: [PAST_INT] } } },
        "not ([customer_id] in (@5))",
      ],
      [
        { not: { "orders.customer_id": { eq: "2.5" } } },
        "not ([customer_id] = cast(@5 as decimal(38, 1)))",
      ],
    ];
    for (const [filter, expected] of cases) {
      const { sql, parameters } = ruleOn(filter);
      expect(where(sql)).toBe(expected);
      expect(parameters[4]).not.toEqual(
        expect.objectContaining({ type: "float" })
      );
    }
    expect(
      ruleOn({ "orders.customer_id": { ne: PAST_INT } }).parameters[4]
    ).toEqual({ type: "bigint", value: PAST_INT });
  });

  it("still leaves the value out of eq and in, and of a not around ne or notIn", () => {
    expect(where(ruleOn({ "orders.customer_id": { eq: PAST_INT } }).sql)).toBe(
      "[customer_id] <> [customer_id]"
    );
    expect(
      where(ruleOn({ "orders.customer_id": { in: [PAST_INT, "2"] } }).sql)
    ).toBe("[customer_id] in (@5)");
    expect(
      where(
        ruleOn({ not: { "orders.customer_id": { notIn: [PAST_INT] } } }).sql
      )
    ).toBe("not ([customer_id] = [customer_id])");
  });

  it("keeps no row for a rule's ne or notIn on a value no exact numeric holds", () => {
    expect(where(ruleOn({ "orders.customer_id": { ne: HUGE } }).sql)).toBe(
      "1 = 0"
    );
    expect(
      where(ruleOn({ "orders.customer_id": { notIn: ["2", HUGE] } }).sql)
    ).toBe("1 = 0");
    expect(
      where(ruleOn({ not: { "orders.customer_id": { in: [HUGE] } } }).sql)
    ).toBe("not (1 = 1)");
    // Where leaving it out drops rows, it is left out.
    expect(
      where(ruleOn({ "orders.customer_id": { in: ["2", HUGE] } }).sql)
    ).toBe("[customer_id] in (@5)");
  });

  it("reads a long notIn's values past the column's type as a list of their own, exactly", () => {
    const values = [
      ...Array.from({ length: 120 }, (_, i) => String(i + 1)),
      PAST_INT,
      "4000000000.5",
    ];
    const { sql, parameters } = ruleOn({
      "orders.customer_id": { notIn: values },
    });
    expect(where(sql)).toBe(
      "([customer_id] not in (select cast([value] as bigint) from openjson(@5)) and [customer_id] not in (select cast([value] as decimal(38, 0)) from openjson(@6)) and [customer_id] not in (select cast([value] as decimal(38, 1)) from openjson(@7)))"
    );
    expect(JSON.parse((parameters[5] as { value: string }).value)).toEqual([
      PAST_INT,
    ]);
    expect(JSON.parse((parameters[6] as { value: string }).value)).toEqual([
      "4000000000.5",
    ]);
  });

  it("compares the value exactly in a case's condition, which picks a branch either way", () => {
    const { sql } = ms({
      from: "orders",
      select: [
        "id",
        {
          calc: {
            case: {
              when: [{ if: { customer_id: { eq: PAST_INT } }, then: 1 }],
              else: 0,
            },
          },
          as: "big",
        },
      ],
    });
    expect(sql).toContain("case when [t0].[customer_id] = @1 then");
  });

  it("compares the value exactly in a caller's ne, and does not move it beside the rule", () => {
    const { sql } = ms(
      {
        from: "orders",
        select: ["id"],
        where: { customer_id: { ne: PAST_INT } },
      },
      { rowRules: { orders: PAID } }
    );
    expect(sql).toContain(
      "select [customer_id], [id] into #r0 from [shop].[orders] where [status] in (@5);"
    );
    expect(sql).toContain("where [t0].[customer_id] <> @6");
  });
});

describe("compileSql: columns named as Object's own properties", () => {
  it("filters, and limits rows by, a column named constructor or prototype", () => {
    for (const dialect of [postgresDialect, mssqlDialect]) {
      const catalog = shopCatalog({
        engine: dialect.name,
        rowRules: {
          orders: rule({ "orders.status": { ne: "void" } }, [
            {
              id: "orders.status",
              name: "constructor",
              type: "text",
              nativeType: dialect.name === "mssql" ? "nvarchar(200)" : "text",
            },
          ]),
        },
      });
      const columns = catalog.tables.find((t) => t.id === "orders")!.columns;
      columns.find((c) => c.name === "status")!.name = "constructor";
      columns.find((c) => c.name === "notes")!.name = "prototype";
      const where = JSON.parse(
        '{"constructor": {"eq": "paid"}, "prototype": {"isNull": true}}'
      ) as object;
      const { sql } = compileSql(
        sqlLanguage.plan(
          sqlLanguage.schema.parse({
            source: "shop",
            from: "orders",
            select: ["id", "constructor"],
            where,
          }),
          catalog,
          { now: NOW }
        ),
        dialect,
        { limit: 101, offset: 0 }
      );
      // The rule, then the caller's conditions beside it.
      const q = (name: string) =>
        dialect.name === "mssql" ? `[${name}]` : `"${name}"`;
      // SQL Server binds the rule's guard first (`ruleGuard`).
      const p = (n: number) =>
        dialect.name === "mssql" ? `@${n + 6}` : `$${n}`;
      expect(sql).toContain(
        `where (${q("constructor")} <> ${p(1)}) and ${q("constructor")} = ${p(2)} and ${q("prototype")} is null`
      );
    }
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

  it("reads a long list for an integer column as bigint and for a decimal one at its scale on SQL Server, leaving out of an in the values the column cannot hold", () => {
    const longIds = Array.from({ length: 120 }, (_, i) => String(i + 1));
    const odd = ["1" + "0".repeat(38), 1e-7, "7.5", "7.505"];
    const ids = ms({
      from: "orders",
      select: ["id"],
      where: { id: { in: [...longIds, ...odd] } },
    });
    expect(ids.sql).toContain(
      "[t0].[id] in (select cast([value] as bigint) from openjson(@1))"
    );
    expect(JSON.parse((ids.parameters[0] as { value: string }).value)).toEqual(
      longIds
    );
    const totals = ms({
      from: "orders",
      select: ["id"],
      where: { total: { notIn: [...longIds, ...odd] } },
    });
    // A notIn compares them exactly (a widened column may hold them), each
    // scale as a list of its own; only a caller's 39-digit value, which no
    // exact number holds, is left out.
    expect(totals.sql).toContain(
      "([t0].[total] not in (select cast([value] as decimal(38, 2)) from openjson(@1)) and [t0].[total] not in (select cast([value] as decimal(38, 3)) from openjson(@2)) and [t0].[total] not in (select cast([value] as decimal(38, 7)) from openjson(@3)))"
    );
    expect(
      totals.parameters
        .slice(0, 3)
        .map((p) => JSON.parse((p as { value: string }).value) as string[])
    ).toEqual([[...longIds, "7.5"], ["7.505"], ["0.0000001"]]);
  });

  it("still reads a long list for a float column as float on SQL Server", () => {
    const catalog = shopCatalog({ engine: "mssql" });
    const total = catalog.tables
      .find((t) => t.id === "orders")!
      .columns.find((c) => c.name === "total")!;
    total.nativeType = "float";
    const { sql } = compileSql(
      sqlLanguage.plan(
        sqlLanguage.schema.parse({
          source: "shop",
          from: "orders",
          select: ["id"],
          where: { total: { in: [...values, 1e300] } },
        }),
        catalog,
        { now: NOW }
      ),
      mssqlDialect,
      { limit: 101, offset: 0 }
    );
    expect(sql).toContain("cast([value] as float)");
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

describe("compile.ts: no module state", () => {
  it("keeps a compilation's state in its own context, never in a module variable", () => {
    const text = readFileSync(
      fileURLToPath(
        new URL("../../../adapters/sql/compile.ts", import.meta.url)
      ),
      "utf8"
    );
    expect(text).not.toMatch(/^let /m);
  });
});

// Every comparison beside a rule was chosen for its column's type as the
// catalogue last read it. Before the copy, a guard reads sys.columns and
// throws when a column the rule or a condition beside it names has gone or
// has another type, so no comparison converts a changed column per row.
describe("compileSql: the guard before a ruled copy, on SQL Server", () => {
  const { PAID, EU } = rules("nvarchar(200)");
  /** The guard's bound values: each column's name and type, then the schema and table. */
  const guardOf = (sql: string, parameters: unknown[], index = 0) => {
    const guard = sql.split("throw 51000")[index]!;
    const at = (n: string) =>
      (parameters[Number(n) - 1] as { type: string; value: string }).value;
    const pairs = [
      .../from \(values (.*?)\) as e \(n, t\)/
        .exec(guard)![1]!
        .matchAll(/\(@(\d+), @(\d+)\)/g),
    ].map((m) => [at(m[1]!), at(m[2]!)]);
    const [, s, t] =
      /object_id\(quotename\(@(\d+)\) \+ N'\.' \+ quotename\(@(\d+)\)\)/.exec(
        guard
      )!;
    return { s: at(s!), t: at(t!), c: pairs };
  };

  it("names the rule's columns and those of the conditions beside it, with their catalogued types", () => {
    const { sql, parameters, ruledAt } = ms(
      {
        from: "orders",
        select: ["id"],
        where: {
          id: { eq: 6 },
          total: { gte: "10.5" },
          // Stays outside the copy: not the guard's.
          customer_id: { gt: "1.5" },
        },
      },
      { rowRules: { orders: PAID } }
    );
    expect(sql).toMatch(
      /^if exists \(select 1 from \(values \(@1, @2\), \(@3, @4\), \(@5, @6\)\) as e \(n, t\) .* from sys\.columns .* throw 51000, N'a row rule column differs from the catalogue', 1; drop table if exists #r0; /
    );
    // Plain parameters: no OPENJSON, which needs compatibility level 130.
    expect(sql.split("drop table")[0]).not.toContain("openjson");
    expect(guardOf(sql, parameters)).toEqual({
      s: "shop",
      t: "orders",
      c: [
        ["id", "bigint"],
        ["status", "nvarchar(200)"],
        ["total", "decimal(12,2)"],
      ],
    });
    expect(ruledAt).toEqual([{ table: "orders", path: ["from"] }]);
  });

  it("guards each copy with its own table, and says where each is read", () => {
    const { sql, parameters, ruledAt } = ms(
      {
        from: "orders",
        join: [{ relation: "customer", type: "inner" }],
        select: ["id"],
      },
      { rowRules: { orders: PAID, customers: EU } }
    );
    expect(sql.match(/throw 51000, [^;]*, (\d+);/g)).toHaveLength(2);
    expect(guardOf(sql, parameters)).toMatchObject({ t: "orders" });
    expect(guardOf(sql, parameters, 1)).toMatchObject({
      t: "customers",
      c: [["region", "nvarchar(200)"]],
    });
    expect(ruledAt).toEqual([
      { table: "orders", path: ["from"] },
      { table: "customers", path: ["join", 0, "relation"] },
    ]);
  });

  it("has nothing to guard where the copy compares no column", () => {
    const { sql } = ms(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: { kind: "never" } } }
    );
    expect(sql).toMatch(/^drop table if exists #r0; /);
  });

  it("is SQL Server's own: Postgres reads its catalogue types at bind time", () => {
    const { sql } = pg(
      { from: "orders", select: ["id"], where: { id: { eq: 6 } } },
      { rowRules: { orders: PAID } }
    );
    expect(sql).not.toContain("sys.columns");
  });
});

// A value the catalogue's type cannot hold is compared exactly, as
// decimal(38, s), where leaving it out would keep more rows. Against a
// column with more integer digits than 38 - s the comparison's common type
// would need more than 38 digits; it is not made. The guard has checked the
// column's type, which holds no such value, so no row equals it: in a rule's
// ne or notIn it leaves out nothing, as `col = col` (unknown for a null, as
// the comparison would be). That holds on a base table only: the copy of a
// view, whose persisted types may be stale, compares it exactly (below).
describe("compileSql: a rule's value whose comparison would need more than 38 digits, on SQL Server", () => {
  const ruleOn = (nativeType: string, filter: Record<string, unknown>) =>
    ms(
      { from: "orders", select: ["id"] },
      {
        rowRules: {
          orders: rule(filter, [
            ruleColumn("orders.customer_id", "number", nativeType),
          ]),
        },
      }
    );
  // The narrowed read's (a base table's); the rule alone compares exactly.
  const where = (sql: string) =>
    /from \[shop\]\.\[orders\] where (.*?); (?:else|select)/.exec(sql)![1];

  it.each([
    ["decimal(38,0)", "1.5"],
    ["bigint", "1." + "0".repeat(19) + "1"],
    ["decimal(30,2)", "1.00000000001"],
  ])("%s against %s", (nativeType, value) => {
    const c = "orders.customer_id";
    expect(where(ruleOn(nativeType, { [c]: { ne: value } }).sql)).toBe(
      "[customer_id] = [customer_id]"
    );
    expect(where(ruleOn(nativeType, { not: { [c]: { eq: value } } }).sql)).toBe(
      "not ([customer_id] <> [customer_id])"
    );
    const notIn = ruleOn(nativeType, { [c]: { notIn: ["2", value] } });
    expect(where(notIn.sql)).toBe("[customer_id] not in (@5)");
    expect((notIn.parameters[4] as { value: unknown }).value).toBe("2");
    // Only the rule alone, for a view, binds it.
    expect(
      notIn.parameters.filter((p) =>
        String((p as { value: unknown }).value).includes(value)
      )
    ).toHaveLength(1);
    expect(
      where(ruleOn(nativeType, { not: { [c]: { in: [value] } } }).sql)
    ).toBe("not ([customer_id] <> [customer_id])");
  });

  it("still compares a value within 38 digits exactly", () => {
    expect(
      where(
        ruleOn("decimal(36,0)", { "orders.customer_id": { ne: "1.5" } }).sql
      )
    ).toBe("[customer_id] <> cast(@5 as decimal(38, 1))");
  });
});

// The guard reads persisted metadata, which for a view can be stale (its
// sys.columns keep the types it was created with), and neither it nor the
// type of a comparison sees a computed column that raises per row. So the
// copy that applies the caller's conditions beside the rule, and that leaves
// out `apart` values, runs only on a base table with no computed column,
// decided from live metadata (no row read); otherwise the rule alone is
// copied, comparing every value exactly, and the caller's conditions are
// applied by the query, on the copy's rows.
describe("compileSql: the copy beside the rule, on a base table only, on SQL Server", () => {
  const { PAID } = rules("nvarchar(200)");
  const branches = (sql: string) => {
    const m =
      /drop table if exists #r0; select top \(0\) \[id\] into #r0 from \[shop\]\.\[orders\] union all select top \(0\) \[id\] from \[shop\]\.\[orders\]; if objectproperty\((object_id\(quotename\(@\d+\) \+ N'\.' \+ quotename\(@\d+\)\)), N'IsUserTable'\) = 1 and not exists \(select 1 from sys\.computed_columns as cc where cc\.object_id = (object_id\(quotename\(@\d+\) \+ N'\.' \+ quotename\(@\d+\)\))\) insert into #r0 select \[id\] from \[shop\]\.\[orders\] where (.*?); else insert into #r0 select \[id\] from \[shop\]\.\[orders\] where (.*?); select /.exec(
        sql
      );
    expect(m, sql).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    return { checked: m![3], alone: m![4] };
  };

  it("applies the caller's conditions beside the rule on a base table only, and in the query's where too", () => {
    const { sql } = ms(
      { from: "orders", select: ["id"], where: { id: { eq: 6 } } },
      { rowRules: { orders: PAID } }
    );
    const { checked, alone } = branches(sql);
    expect(checked).toMatch(/^\(\[status\] in \(@\d+\)\) and \[id\] = @\d+$/);
    expect(alone).toMatch(/^\[status\] in \(@\d+\)$/);
    expect(sql).toMatch(/from #r0 as \[t0\] where \[t0\]\.\[id\] = @\d+/);
  });

  it("leaves out a value past 38 digits on a base table only, and compares it exactly otherwise", () => {
    const { sql } = ms(
      { from: "orders", select: ["id"] },
      {
        rowRules: {
          orders: rule({ "orders.customer_id": { ne: "1.5" } }, [
            ruleColumn("orders.customer_id", "number", "decimal(38,0)"),
          ]),
        },
      }
    );
    const { checked, alone } = branches(sql);
    expect(checked).toBe("[customer_id] = [customer_id]");
    expect(alone).toMatch(
      /^\[customer_id\] <> cast\(@\d+ as decimal\(38, 1\)\)$/
    );
  });

  it("copies with no branch where the rule alone is all there is to copy", () => {
    const { sql } = ms(
      { from: "orders", select: ["id"] },
      { rowRules: { orders: PAID } }
    );
    expect(sql).not.toContain("IsUserTable");
    expect(sql).toContain(
      "drop table if exists #r0; select [id] into #r0 from [shop].[orders] where [status] in (@5); select "
    );
  });
});
