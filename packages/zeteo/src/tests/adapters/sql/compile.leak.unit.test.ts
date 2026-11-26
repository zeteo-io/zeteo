// @module-tag unit
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import type { RowRule, RuleColumn } from "../../../row-rules/resolve.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { metricsCatalog } from "../../support/pure/metricsCatalog.js";
import type { ShopOptions } from "../../support/pure/shopCatalog.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { sqlLanguage } from "../../../adapters/sql/language.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { measure } from "../../support/pure/metricsCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { describe, expect, it } from "vitest";
import type {
  QueryableType,
  ResolvedFilter,
  TablePlan,
  WhereSubject,
} from "../../../adapters/sql/types.js";

// What is evaluated on the rows a row rule leaves out: only the rule, and
// conditions of the caller's that cannot raise an error on any row (a column
// read as it is against values bound as exactly its own type), moved beside
// the rule so an index can serve them. Anything else (a calculation, an
// `or`, a value of another type, a match on Postgres) stays outside the
// rule's read. And a table read twice under one rule is copied once on SQL
// Server, with only the columns read.

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

/** The statement (SQL Server) or WITH query (Postgres) that reads the rule's rows: everything evaluated beside the rule. */
const ruledReads = (text: string): string[] =>
  [
    ...text.matchAll(/select [^;]*? into #r\d+ from [^;]*;/g),
    ...text.matchAll(/materialized \(select .*?\) select \* from "r"/g),
  ].map((m) => m[0]);

describe("compileSql: conditions that cannot raise, beside the rule", () => {
  const pgRules = rules("text");
  const msRules = rules("nvarchar(200)");

  it("applies a plain comparison on the ruled from table beside its rule, and keeps the rest outside (Postgres)", () => {
    const { sql, parameters } = pg(
      {
        from: "orders",
        select: ["id", { calc: { mul: ["total", 1000] }, as: "p" }],
        where: {
          id: { eq: 6 },
          total: { gte: "10.5" },
          ordered_on: { between: ["2026-01-01", "2026-06-30"] },
          notes: { isNull: false },
          status: { startsWith: "p" },
          p: { gt: 5 },
        },
      },
      { rowRules: { orders: pgRules.PAID } }
    );
    expect(ruledReads(sql)).toEqual([
      'materialized (select "id", "status", "total" from "shop"."orders" where ("status" in ($2)) and "id" = $3 and "total" >= cast($4 as numeric) and "ordered_on" between $5 and $6 and "notes" is not null) select * from "r"',
    ]);
    expect(parameters.slice(1, 6)).toEqual([
      "paid",
      6,
      "10.5",
      "2026-01-01",
      "2026-06-30",
    ]);
    // ILIKE raises on a column with a nondeterministic collation: never beside the rule.
    expect(sql).toMatch(
      /\) as "t0" where \("t0"\."status" ilike \$\d+ escape '\\' and \("t0"\."total" \* cast\(\$\d+ as bigint\)\) > \$\d+\)/
    );
  });

  it("applies a plain comparison on the ruled from table beside its rule, binding the column's own type (SQL Server)", () => {
    const { sql, parameters } = ms(
      {
        from: "orders",
        select: ["id"],
        where: {
          id: { eq: 6 },
          customer_id: { in: [1, 2] },
          total: { gte: "10.5" },
          status: { startsWith: "p" },
          created_at: { gte: "2026-01-01T00:00:00Z" },
        },
      },
      { rowRules: { orders: msRules.PAID } }
    );
    expect(ruledReads(sql)).toEqual([
      "select [id] into #r0 from [shop].[orders] where ([status] in (@2)) and [id] = @3 and [customer_id] in (@4, @5) and [total] >= cast(@6 as decimal(12, 2)) and lower([status]) like lower(@7) escape '\\' and [created_at] >= cast(@8 as datetimeoffset);",
    ]);
    // After the rule's guard (`ruleGuard`).
    expect(parameters.slice(1, 8)).toEqual([
      { type: "nvarchar", value: "paid" },
      { type: "bigint", value: "6" },
      { type: "int", value: 1 },
      { type: "int", value: 2 },
      { type: "nvarchar", value: "10.5" },
      { type: "nvarchar", value: "p%" },
      { type: "nvarchar", value: "2026-01-01T00:00:00Z" },
    ]);
    // Nothing is left for the query's own where.
    expect(sql.slice(sql.indexOf("from #r0"))).not.toContain(" where ");
  });

  it("keeps a comparison whose value is not the column's own type outside (Postgres: a decimal or an out-of-range integer against an integer column)", () => {
    const { sql } = pg(
      {
        from: "orders",
        select: ["id"],
        where: { customer_id: { gt: "1.5" }, id: { lt: "1" + "0".repeat(30) } },
      },
      { rowRules: { orders: pgRules.PAID } }
    );
    expect(ruledReads(sql)).toEqual([
      'materialized (select "customer_id", "id" from "shop"."orders" where "status" in ($1)) select * from "r"',
    ]);
    expect(sql).toContain('"t0"."customer_id" > cast($2 as numeric)');
  });

  it("keeps a comparison whose value is not the column's own type outside (SQL Server: past an int's range, finer than a decimal's scale)", () => {
    const { sql } = ms(
      {
        from: "orders",
        select: ["id"],
        where: {
          customer_id: { gt: 3_000_000_000 },
          total: { lt: "10.505" },
          created_at: { gte: "2026-01-01T00:00:00.123456789Z" },
        },
      },
      { rowRules: { orders: msRules.PAID } }
    );
    expect(ruledReads(sql)).toEqual([
      "select [created_at], [customer_id], [id], [total] into #r0 from [shop].[orders] where [status] in (@2);",
    ]);
  });

  it("keeps or, not, a calculation and a fixed measure's value outside", () => {
    for (const where of [
      { or: [{ id: { eq: 6 } }, { id: { eq: 7 } }] },
      { not: { id: { eq: 6 } } },
      { total: { gt: { measure: "smallest" } } },
    ]) {
      for (const [compile, r] of [
        [pg, pgRules],
        [ms, msRules],
      ] as const) {
        const { sql } = compile(
          { from: "orders", select: ["id"], where },
          {
            rowRules: { orders: r.PAID },
            measures: [measure("smallest", { min: "total" }, { fixed: true })],
          }
        );
        for (const read of ruledReads(sql)) {
          expect(read).not.toMatch(
            /\bid\b.*\bid\b|"id" = |\[id\] = |"total" >|\[total\] >/
          );
        }
      }
    }
  });

  it("applies a condition on an inner-joined ruled table beside its rule, and never one on a left-joined table", () => {
    for (const [compile, r] of [
      [pg, pgRules],
      [ms, msRules],
    ] as const) {
      const inner = compile(
        {
          from: "orders",
          join: [{ relation: "customer", type: "inner" }],
          select: ["id", "customer.name"],
          where: { "customer.name": { eq: "Ada" } },
        },
        { rowRules: { customers: r.EU } }
      ).sql;
      expect(ruledReads(inner)).toHaveLength(1);
      expect(ruledReads(inner)[0]).toMatch(/region.* and .?name.? = /);
      const left = compile(
        {
          from: "orders",
          join: [{ relation: "customer", type: "left" }],
          select: ["id", "customer.name"],
          where: { "customer.name": { eq: "Ada" } },
        },
        { rowRules: { customers: r.EU } }
      ).sql;
      expect(ruledReads(left)[0]).not.toMatch(/name.? = /);
      expect(left).toMatch(/where .t1.\..name. = /);
    }
  });

  it("compiles with every condition outside when asked to", () => {
    const query = { from: "orders", select: ["id"], where: { id: { eq: 6 } } };
    const options = { rowRules: { orders: msRules.PAID } };
    const outside = compileSql(
      sqlLanguage.plan(
        sqlLanguage.schema.parse({ source: "shop", ...query }),
        shopCatalog({ engine: "mssql", ...options }),
        { now: NOW }
      ),
      mssqlDialect,
      { limit: 101, offset: 0 },
      { pushDown: false }
    );
    expect(ruledReads(outside.sql)).toEqual([
      "select [id] into #r0 from [shop].[orders] where [status] in (@2);",
    ]);
    expect(outside.sql).toContain("from #r0 as [t0] where [t0].[id] = @3");
  });

  it("pushes a metric part's range on its own table's date column beside the rule", () => {
    const { sql } = pg(
      {
        metrics: ["revenue"],
        bucket: "month",
        range: { gte: { date: "2026-01-01" }, lt: { date: "2026-07-01" } },
      },
      { rowRules: { orders: pgRules.PAID } },
      true
    );
    expect(ruledReads(sql)[0]).toMatch(
      /where \("status" in \(\$\d\)\) and "ordered_on" >= \$\d and "ordered_on" < \$\d\)/
    );
  });
});

describe("compileSql: one read per table and rule on SQL Server", () => {
  const { PAID } = rules("nvarchar(200)");

  it("stages a table read by a fixed measure and the query alike once, with the columns both read", () => {
    const { sql } = ms(
      {
        from: "orders",
        select: ["id", { measure: "smallest" }],
        groupBy: ["id"],
      },
      {
        rowRules: { orders: PAID },
        measures: [measure("smallest", { min: "total" }, { fixed: true })],
      }
    );
    expect(ruledReads(sql)).toEqual([
      "select [id], [total] into #r0 from [shop].[orders] where [status] in (@2);",
    ]);
    expect(sql).toContain("from #r0 as [t0]");
    expect(sql).toContain("from #r0 as [f1_t0]");
    expect(sql).not.toContain("#r1");
  });

  it("stages a table apart where its conditions differ", () => {
    const { sql } = ms(
      {
        from: "orders",
        select: ["id", { measure: "smallest" }],
        groupBy: ["id"],
        where: { id: { gt: 2 } },
      },
      {
        rowRules: { orders: PAID },
        measures: [measure("smallest", { min: "total" }, { fixed: true })],
      }
    );
    expect(ruledReads(sql)).toHaveLength(2);
  });

  it("stages every part of a metric over one table once", () => {
    const { sql } = ms(
      {
        metrics: ["paid_share"],
        bucket: "month",
        range: { gte: { date: "2026-01-01" }, lt: { date: "2026-07-01" } },
      },
      { rowRules: { orders: PAID } },
      true
    );
    const reads = ruledReads(sql);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("[ordered_on] >= cast(@");
    expect(sql.match(/from #r0 as \[t0\]/g)).toHaveLength(2);
  });
});

describe("compileSql: a condition whose types do not match stays outside the rule's read", () => {
  // Hand-built where clauses on columns of other types than the planner
  // would pair them with: whatever reaches the compiler, a value that is not
  // bound as exactly the column's own type is never evaluated beside the rule.
  type Case = [label: string, filter: ResolvedFilter<WhereSubject>];
  const on = (name: string, type: QueryableType, nativeType: string) => ({
    alias: "t0",
    name,
    type,
    nativeType,
  });
  const eq = (
    name: string,
    type: QueryableType,
    nativeType: string,
    value: string | number | boolean
  ): ResolvedFilter<WhereSubject> => ({
    kind: "compare",
    op: "eq",
    subject: on(name, type, nativeType),
    value,
  });
  const gt = (
    name: string,
    type: QueryableType,
    nativeType: string,
    value: string | number
  ): ResolvedFilter<WhereSubject> => ({
    kind: "compare",
    op: "gt",
    subject: on(name, type, nativeType),
    value,
  });
  const match = (
    name: string,
    type: QueryableType,
    nativeType: string
  ): ResolvedFilter<WhereSubject> => ({
    kind: "match",
    op: "contains",
    subject: on(name, type, nativeType),
    value: "1",
  });

  const MSSQL: Case[] = [
    ["varchar column, number value", eq("code", "text", "varchar(20)", 5)],
    ["varchar column, text value", eq("code", "text", "varchar(20)", "abc")],
    ["varchar column read as a number", gt("code", "number", "varchar(20)", 5)],
    ["int column read as text", eq("num", "text", "int", "5")],
    ["date column, number value", eq("day", "date", "date", 5)],
    [
      "date column, timestamp value",
      gt("day", "timestamp", "date", "2026-01-01T00:00:00Z"),
    ],
    ["match on a number column", match("num", "number", "int")],
    ["match on a varchar column", match("code", "text", "varchar(20)")],
    ["nchar column", eq("code", "text", "nchar(10)", "abc")],
    [
      "uniqueidentifier column",
      eq("ref", "text", "uniqueidentifier", "not-a-guid"),
    ],
    ["float column", gt("f", "number", "float", "0.1")],
    ["real column", gt("f", "number", "real", 1)],
    ["money column", gt("m", "number", "money", 1)],
    [
      "smalldatetime column",
      gt("t", "timestamp", "smalldatetime", "2026-01-01T00:00:00Z"),
    ],
    [
      "datetime2(3), finer value",
      gt("t", "timestamp", "datetime2(3)", "2026-01-01T00:00:00.1234Z"),
    ],
    [
      "datetimeoffset, offset past 14:00",
      gt("t", "timestamp", "datetimeoffset(7)", "2026-01-01T00:00:00+15:00"),
    ],
    [
      "datetime before 1754",
      gt("t", "timestamp", "datetime", "1700-01-01T00:00:00Z"),
    ],
    ["text column", eq("t", "text", "text", "abc")],
    [
      "decimal finer than its scale",
      gt("d", "number", "decimal(12,2)", "1.005"),
    ],
    ["decimal past its precision", gt("d", "number", "decimal(4,2)", "123")],
    ["decimal in exponent form", gt("d", "number", "decimal(12,2)", 1e-7)],
    ["tinyint past its range", gt("n", "number", "tinyint", 256)],
  ];
  const POSTGRES: Case[] = [
    [
      "varchar column, number value",
      eq("code", "text", "character varying(20)", 5),
    ],
    [
      "varchar column read as a number",
      gt("code", "number", "character varying(20)", 5),
    ],
    ["number column, text value", eq("num", "number", "integer", "abc")],
    ["integer column read as text", eq("num", "text", "integer", "5")],
    ["date column, number value", eq("day", "date", "date", 5)],
    [
      "date column, timestamp value",
      gt("day", "timestamp", "date", "2026-01-01T00:00:00Z"),
    ],
    ["match on a text column", match("name", "text", "text")],
    ["match on a number column", match("num", "number", "integer")],
    ["integer column, decimal value", gt("num", "number", "integer", "1.5")],
    ["smallint past its range", gt("num", "number", "smallint", 40000)],
    [
      "float column, decimal value",
      gt("f", "number", "double precision", "0.1"),
    ],
    ["money column", gt("m", "number", "money", 1)],
    ["enum column", eq("mood", "text", "shop.mood (enum)", "ok")],
    ["domain column", eq("d", "text", "shop.token (domain over uuid)", "x")],
    ["citext column", eq("c", "text", "citext", "abc")],
    ["boolean column, text value", eq("b", "boolean", "boolean", "true")],
  ];

  it("mssql: an equality no value of the column can meet is the column against itself, binding nothing", () => {
    const sql = outside(mssqlDialect, eq("num", "number", "int", "abc"));
    expect(ruledReads(sql)).toEqual([
      "select [id] into #r0 from [shop].[orders] where ([status] in (@2)) and [num] <> [num];",
    ]);
  });

  const outside = (
    dialect: SqlDialect,
    filter: ResolvedFilter<WhereSubject>
  ) => {
    const r = rules(dialect.name === "mssql" ? "nvarchar(200)" : "text");
    const plan = sqlLanguage.plan(
      sqlLanguage.schema.parse({
        source: "shop",
        from: "orders",
        select: ["id"],
      }),
      shopCatalog({ engine: dialect.name, rowRules: { orders: r.PAID } }),
      { now: NOW }
    ) as TablePlan;
    return compileSql({ ...plan, where: filter }, dialect, {
      limit: 101,
      offset: 0,
    }).sql;
  };

  for (const [dialect, cases] of [
    [mssqlDialect, MSSQL],
    [postgresDialect, POSTGRES],
  ] as const) {
    it.each(cases)(`${dialect.name}: %s`, (_, filter) => {
      const sql = outside(dialect, filter);
      const reads = ruledReads(sql);
      expect(reads).toHaveLength(1);
      // The rule alone decides what the read holds.
      expect(reads[0]).toMatch(
        dialect.name === "mssql"
          ? /from \[shop\]\.\[orders\] where \[status\] in \(@2\);$/
          : /from "shop"\."orders" where "status" in \(\$1\)\) select \* from "r"$/
      );
      // The condition is the query's own, on the read's rows.
      expect(
        sql.slice(
          sql.lastIndexOf(dialect.name === "mssql" ? "#r0 as" : '"t0" where')
        )
      ).toMatch(/where .*t0.\..(code|num|day|ref|f|m|t|d|n|name|mood|c|b)./);
    });
  }
});

describe("compileSql: a timestamp beside the rule binds no more than SQL Server reads (SQL Server)", () => {
  // SQL Server refuses a date or time text with more than 7 fractional
  // digits. Beside the rule, such a text would fail only when a row reached
  // the condition: whether a hidden row matched the rest. So it is cut to 7
  // digits, as `value` cuts it, before every cast.
  const compare = (
    nativeType: string,
    value: string
  ): ResolvedFilter<WhereSubject> => ({
    kind: "compare",
    op: "gte",
    subject: { alias: "t0", name: "t", type: "timestamp", nativeType },
    value,
  });
  const besideTheRule = (filter: ResolvedFilter<WhereSubject>) => {
    const r = rules("nvarchar(200)");
    const plan = sqlLanguage.plan(
      sqlLanguage.schema.parse({
        source: "shop",
        from: "orders",
        select: ["id"],
      }),
      shopCatalog({ engine: "mssql", rowRules: { orders: r.PAID } }),
      { now: NOW }
    ) as TablePlan;
    return compileSql({ ...plan, where: filter }, mssqlDialect, {
      limit: 101,
      offset: 0,
    });
  };

  it.each([
    ["datetime2(3)", "2026-01-01T00:00:00.000000000Z"],
    ["datetime2(3)", "2026-01-01T00:00:00.100000000+01:00"],
    ["datetimeoffset(3)", "2026-01-01T00:00:00.000000000Z"],
    ["datetimeoffset(3)", "2026-01-01T00:00:00.100000000+01:00"],
    ["datetime2(7)", "2026-01-01T00:00:00.123456700Z"],
    ["datetimeoffset(7)", "2026-01-01T00:00:00.123456700Z"],
  ])("%s against %s", (nativeType, value) => {
    const { sql, parameters } = besideTheRule(compare(nativeType, value));
    // Applied beside the rule: the column holds the value exactly.
    expect(ruledReads(sql)[0]).toMatch(/and \[t\] >= cast\(/);
    const texts = parameters
      .map((p) => (p as { value: unknown }).value)
      .filter(
        (v): v is string => typeof v === "string" && v.startsWith("2026")
      );
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toMatch(/\.\d{8}/);
    expect(texts[0]).toBe(value.replace(/(\.\d{7})\d+/, "$1"));
  });
});
