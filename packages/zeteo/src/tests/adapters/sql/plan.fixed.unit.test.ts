// @module-tag unit
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { MAX_FIXED_MEASURES } from "../../../adapters/sql/measures.js";
import type { ResolvedExpr } from "../../../adapters/sql/types.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import type { SqlDialect } from "../../../adapters/sql/dialect.js";
import { visibleMeasures } from "../../../measures/visible.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import type {
  MeasureRow,
  VisibleCatalog,
} from "../../../grants/visibleCatalog.js";
import {
  shopCatalog,
  type ShopOptions,
} from "../../support/pure/shopCatalog.js";

// A fixed measure ignores the query it is used in: it is computed over its
// whole home table (its own where still applies) as a scalar subquery, from
// any table, anywhere an expression or a comparison value can be.

const NOW = new Date("2026-06-15T12:00:00Z");
const PAID = { status: { eq: "paid" } };

const measure = (
  name: string,
  formula: unknown,
  options: { where?: unknown; table?: string; fixed?: boolean } = {}
): MeasureRow =>
  ({
    id: `m-${name}`,
    sourceId: "src",
    tableId: options.table ?? "orders",
    name,
    description: `The ${name}`,
    formula,
    where: options.where ?? null,
    fixed: options.fixed ?? false,
    dateColumn: null,
  }) as MeasureRow;

const fixed = (
  name: string,
  formula: unknown,
  table: string,
  where?: unknown
): MeasureRow => measure(name, formula, { table, where, fixed: true });

const MEASURES: MeasureRow[] = [
  // The latest launch: the shape of "last actuals month", on another table.
  fixed("last_launch", { max: "launched_on" }, "products"),
  fixed("last_paid_day", { max: "ordered_on" }, "orders", PAID),
  fixed("line_count", { count: "*" }, "order_lines"),
  fixed("top_balance", { max: "balance" }, "billing_accounts"),
  fixed("pro_accounts", { count: "*" }, "customers", {
    "account.plan": { eq: "pro" },
  }),
  measure("total_revenue", { sum: "total" }),
  measure(
    "after_launch",
    { sum: "total" },
    { where: { ordered_on: { gt: { measure: "last_launch" } } } }
  ),
  measure(
    "paid_scaled",
    { sum: { mul: ["total", { measure: "top_balance" }] } },
    { where: PAID }
  ),
  measure("per_line", {
    div: [{ measure: "total_revenue" }, { measure: "line_count" }],
  }),
];

const catalogWith = (
  rows: MeasureRow[] = MEASURES,
  options: ShopOptions = {}
): VisibleCatalog => shopCatalog({ ...options, measures: rows });

const plan = (
  query: object,
  catalog: VisibleCatalog = catalogWith(),
  from = "orders"
) =>
  planSql(sqlQuerySchema.parse({ source: "shop", from, ...query }), catalog, {
    now: NOW,
  });

/** The SQL with SQL Server's [quotes] written as Postgres's, so one pattern fits both. */
const compileOn = (dialect: SqlDialect) => (query: object, from?: string) => {
  const compiled = compileSql(
    plan(query, catalogWith(MEASURES, { engine: dialect.name }), from),
    dialect,
    { limit: 101, offset: 0 }
  );
  return { ...compiled, sql: compiled.sql.replace(/[[\]]/g, '"') };
};
const pg = compileOn(postgresDialect);
const ms = compileOn(mssqlDialect);

/** Every field of the refusal planning `query` gets. */
const refusal = (query: object, catalog?: VisibleCatalog, from?: string) => {
  try {
    plan(query, catalog, from);
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return {
      name: err.name,
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      path: err.path,
      suggestions: err.suggestions,
      details: err.details,
    };
  }
  throw new Error("the query was planned");
};

const calcOf = (query: object, from?: string): ResolvedExpr => {
  const item = plan(query, undefined, from).select[0]!;
  if (item.kind !== "calc") throw new Error(`a ${item.kind} item`);
  return item.expr;
};

describe("planSql: a fixed measure", () => {
  it("is a scalar subquery over its own home table, usable from any table", () => {
    for (const from of ["orders", "customers", "categories"]) {
      const p = plan({ select: [{ measure: "last_launch" }] }, undefined, from);
      expect(p.select[0]).toMatchObject({
        kind: "calc",
        level: "group",
        output: "last_launch",
        type: "date",
      });
      expect((p.select[0] as { expr: ResolvedExpr }).expr).toEqual({
        kind: "scalar",
        type: "date",
        plan: {
          alias: "f1",
          from: { alias: "f1_t0", schemaName: "shop", name: "products" },
          joins: [],
          expr: {
            kind: "aggregate",
            fn: "max",
            type: "date",
            arg: {
              kind: "column",
              column: {
                alias: "f1_t0",
                name: "launched_on",
                type: "date",
                nativeType: "date",
              },
            },
          },
        },
      });
      // Its joins and the query's are apart: the query joins nothing.
      expect(p.joins).toEqual([]);
    }
  });

  it("alone in select gives one row: the query groups by nothing", () => {
    for (const compile of [pg, ms]) {
      const { sql } = compile({ select: [{ measure: "last_launch" }] });
      expect(sql).toMatch(/group by \(\)/);
      expect(sql).toContain(`"f1_t0"`);
    }
    // A query with an aggregate already gives one row and is compiled as before.
    expect(
      pg({ select: [{ sum: "total" }, { measure: "last_launch" }] }).sql
    ).not.toMatch(/group by/);
  });

  it("applies its own where inside its subquery, aliased as its own", () => {
    const expr = calcOf({ select: [{ measure: "last_paid_day" }] });
    expect(expr).toMatchObject({
      kind: "scalar",
      plan: {
        from: { alias: "f1_t0", name: "orders" },
        expr: {
          kind: "aggregate",
          fn: "max",
          arg: {
            kind: "case",
            branches: [
              {
                when: {
                  kind: "compare",
                  op: "eq",
                  subject: { alias: "f1_t0", name: "status" },
                  value: "paid",
                },
              },
            ],
          },
        },
      },
    });
  });

  it("joins what its where reads inside its subquery only", () => {
    const p = plan({ select: [{ measure: "pro_accounts" }] });
    expect(p.joins).toEqual([]);
    const expr = (p.select[0] as { expr: ResolvedExpr }).expr;
    expect(expr).toMatchObject({
      kind: "scalar",
      plan: {
        from: { alias: "f1_t0", name: "customers" },
        joins: [
          {
            alias: "f1_t1",
            relation: "account",
            type: "left",
            on: [["f1_t0", "account_id", "id"]],
          },
        ],
      },
    });
  });

  it("refuses a subquery whose own joins pass the source's max_joins", () => {
    const deep = fixed("deep_count", { count: "*" }, "order_lines", {
      "product.category.name": { eq: "x" },
    });
    expect(
      refusal(
        { select: [{ measure: "deep_count" }] },
        catalogWith([deep], { maxJoins: 1 })
      )
    ).toMatchObject({
      code: "not_found_or_not_accessible",
    });
    // Within the limit it plans, and the outer query's joins do not count.
    const p = plan(
      {
        join: ["customer", "customer.account"],
        select: [{ measure: "deep_count" }],
      },
      catalogWith([deep], { maxJoins: 2 })
    );
    expect(p.joins.map((j) => j.alias)).toEqual(["t1", "t2"]);
  });

  it("is group-level in a calc with an aggregate, compiled inline", () => {
    const query = {
      select: [
        {
          calc: { div: [{ sum: "total" }, { measure: "line_count" }] },
          as: "x",
        },
      ],
    };
    const p = plan(query);
    expect(p.select[0]).toMatchObject({ kind: "calc", level: "group" });
    for (const compile of [pg, ms]) {
      const { sql } = compile(query);
      expect(sql).toMatch(/\(select count/i);
      expect(sql).not.toMatch(/on 1 = 1/);
    }
  });

  it("is row-level beside a column, read from a joined one-row table", () => {
    const query = {
      select: [
        "id",
        { calc: { sub: ["total", { measure: "top_balance" }] }, as: "x" },
      ],
    };
    expect(plan(query).select[1]).toMatchObject({ level: "row" });
    for (const compile of [pg, ms]) {
      const { sql } = compile(query);
      expect(sql).toMatch(/on 1 = 1/);
      expect(sql).toContain(`"f1"."v"`);
    }
  });

  it("works inside another measure's aggregate, which never pushes its where into it", () => {
    const expr = calcOf({ select: [{ measure: "paid_scaled" }] });
    // The scalar inside the sum is the fixed measure planned alone: no status case.
    const scalar = (
      ((expr as { arg: ResolvedExpr }).arg as { branches: unknown[] })
        .branches[0] as { then: { args: ResolvedExpr[] } }
    ).then.args[1];
    expect(scalar).toMatchObject({
      kind: "scalar",
      plan: {
        from: { name: "accounts", schemaName: "billing" },
        expr: { kind: "aggregate", fn: "max", arg: { kind: "column" } },
      },
    });
    for (const compile of [pg, ms]) {
      const { sql } = compile({ select: [{ measure: "paid_scaled" }] });
      // Inside an aggregate it is a column of a joined derived table: SQL
      // Server does not aggregate over a subquery.
      expect(sql).toMatch(/on 1 = 1/);
      expect(sql).toMatch(/sum\([^)]*"f1"\."v"/);
    }
  });

  it("works inside a calc's aggregate written in the query", () => {
    const p = plan({
      select: [
        {
          sum: { mul: ["total", { measure: "line_count" }] },
          as: "x",
        },
      ],
    });
    expect(p.select[0]).toMatchObject({ kind: "calc", level: "group" });
  });

  it("is a comparison value in where, in a case if and in a measure's where", () => {
    const p = plan({
      select: ["id"],
      where: { ordered_on: { gt: { measure: "last_launch" } } },
    });
    expect(p.where).toMatchObject({
      kind: "compare",
      op: "gt",
      subject: { alias: "t0", name: "ordered_on" },
      value: { kind: "scalar", type: "date" },
    });
    expect(
      plan({
        select: [
          {
            sum: {
              case: {
                when: [
                  {
                    if: { ordered_on: { lte: { measure: "last_launch" } } },
                    then: "total",
                  },
                ],
              },
            },
            as: "x",
          },
        ],
      }).select[0]
    ).toMatchObject({ kind: "calc", level: "group" });
    const between = plan({
      select: ["id"],
      where: {
        ordered_on: {
          between: [{ measure: "last_launch" }, { measure: "last_paid_day" }],
        },
      },
    }).where;
    expect(between).toMatchObject({
      kind: "between",
      low: { kind: "scalar" },
      high: { kind: "scalar" },
    });
    for (const compile of [pg, ms]) {
      const { sql } = compile({ select: [{ measure: "after_launch" }] });
      expect(sql).toMatch(/> "f1"\."v"/);
    }
  });

  it("is a comparison value in having", () => {
    const p = plan({
      select: ["status", { sum: "total", as: "s" }],
      groupBy: ["status"],
      having: { s: { gt: { measure: "line_count" } } },
    });
    expect(p.having).toMatchObject({ value: { kind: "scalar" } });
    expect(
      pg({
        select: ["status", { sum: "total", as: "s" }],
        groupBy: ["status"],
        having: { s: { gt: { measure: "line_count" } } },
      }).sql
    ).toMatch(/having .*\(select count/i);
  });

  it("refuses a measure that is not fixed as a comparison value with invalid_value at the value", () => {
    expect(
      refusal({
        select: ["id"],
        where: { total: { gt: { measure: "total_revenue" } } },
      })
    ).toMatchObject({
      code: "invalid_value",
      path: ["where", "total", "gt"],
    });
  });

  it("refuses a fixed measure of another type than what it is compared with", () => {
    expect(
      refusal({
        select: ["id"],
        where: { total: { gt: { measure: "last_launch" } } },
      })
    ).toMatchObject({
      code: "invalid_value",
      path: ["where", "total", "gt"],
    });
  });

  it("refuses a comparison value naming no measure exactly as one the caller cannot see", () => {
    const query = {
      select: ["id"],
      where: { ordered_on: { gt: { measure: "last_launch" } } },
    };
    const hidden = refusal(
      query,
      catalogWith(MEASURES, { hidden: ["products.launched_on"] })
    );
    const absent = refusal(
      query,
      catalogWith(MEASURES.filter((m) => m.name !== "last_launch"))
    );
    expect(hidden).toEqual(absent);
    expect(hidden).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["where", "ordered_on", "gt", "measure"],
    });
  });

  it("is invisible when it reads an ungranted column: the same refusal as a measure never defined", () => {
    const query = { select: [{ measure: "last_launch" }] };
    expect(
      refusal(
        query,
        catalogWith(MEASURES, { hidden: ["products.launched_on"] })
      )
    ).toEqual(
      refusal(
        query,
        catalogWith(MEASURES.filter((m) => m.name !== "last_launch"))
      )
    );
    expect(
      refusal(query, catalogWith(MEASURES, { hidden: ["products"] }))
    ).toMatchObject({ code: "not_found_or_not_accessible" });
  });

  it("hides a measure using a fixed measure the caller cannot see", () => {
    const names = (options: ShopOptions) =>
      visibleMeasures(catalogWith([], options), MEASURES)
        .map((m) => m.name)
        .sort();
    expect(names({})).toEqual(MEASURES.map((m) => m.name).sort());
    const hidden = names({ hidden: ["products.launched_on"] });
    expect(hidden).not.toContain("last_launch");
    expect(hidden).not.toContain("after_launch");
    expect(names({ hidden: ["billing_accounts.balance"] })).not.toContain(
      "paid_scaled"
    );
    // Visible measures carry the flag.
    expect(
      visibleMeasures(catalogWith([]), MEASURES).find(
        (m) => m.name === "last_launch"
      )
    ).toMatchObject({ fixed: true, dateColumn: null });
  });

  it("is not refused with measure_needs_single_rows in a query joining a to-many relation", () => {
    const p = plan({
      join: ["lines"],
      select: [{ sum: "lines.quantity", as: "q" }, { measure: "last_launch" }],
    });
    expect(p.select[1]).toMatchObject({ kind: "calc", level: "group" });
    // A measure that is not fixed is still refused there.
    expect(
      refusal({ join: ["lines"], select: [{ measure: "total_revenue" }] })
    ).toMatchObject({ code: "measure_needs_single_rows" });
  });

  it("uses other fixed measures as nested subqueries with their own aliases", () => {
    const rows = [
      ...MEASURES,
      fixed(
        "launch_lines",
        {
          add: [{ count: "*" }, { measure: "last_paid_count" }],
        },
        "order_lines"
      ),
      fixed("last_paid_count", { count: "*" }, "orders", PAID),
    ];
    const p = plan(
      { select: [{ measure: "launch_lines" }] },
      catalogWith(rows)
    );
    const outer = (p.select[0] as { expr: ResolvedExpr }).expr as {
      plan: { alias: string; from: { alias: string }; expr: ResolvedExpr };
    };
    expect(outer.plan.alias).toBe("f1");
    expect(outer.plan.from.alias).toBe("f1_t0");
    expect((outer.plan.expr as { args: ResolvedExpr[] }).args[1]).toMatchObject(
      {
        kind: "scalar",
        plan: { alias: "f2", from: { alias: "f2_t0", name: "orders" } },
      }
    );
  });

  it("refuses fixed measures using each other with measure_cycle", () => {
    const rows = [
      fixed("ping", { add: [{ count: "*" }, { measure: "pong" }] }, "orders"),
      fixed("pong", { add: [{ count: "*" }, { measure: "ping" }] }, "orders"),
    ];
    // Neither plans alone, so neither is visible: both are not found.
    expect(visibleMeasures(catalogWith([]), rows)).toEqual([]);
  });

  it(`refuses more than ${MAX_FIXED_MEASURES} fixed-measure subqueries with too_complex`, () => {
    const many = Array.from({ length: MAX_FIXED_MEASURES + 1 }, (_, i) =>
      fixed(`fx${i}`, { count: "*" }, "products")
    );
    const select = (n: number) =>
      many.slice(0, n).map((m) => ({ measure: m.name }));
    expect(() =>
      plan({ select: select(MAX_FIXED_MEASURES) }, catalogWith(many))
    ).not.toThrow();
    expect(
      refusal({ select: select(MAX_FIXED_MEASURES + 1) }, catalogWith(many))
    ).toMatchObject({
      code: "too_complex",
      path: ["select", MAX_FIXED_MEASURES, "measure"],
    });
    // The same fixed measure used twice is one subquery.
    const twice = plan(
      {
        select: [
          { measure: "last_launch" },
          {
            calc: { dateAdd: [{ measure: "last_launch" }, 1, "day"] },
            as: "next",
          },
        ],
      },
      catalogWith()
    );
    const aliases = twice.select.map(
      (s) => JSON.stringify(s).match(/"alias":"(f\d+)"/)?.[1] ?? "none"
    );
    expect(aliases).toEqual(["f1", "f1"]);
  });

  it("lists fixed measures among the suggestions for any table", () => {
    expect(
      refusal({ select: [{ measure: "last_lunch" }] }, undefined, "customers")
        .suggestions
    ).toContain("last_launch");
  });
});

describe("sqlQuerySchema: fixed measures", () => {
  const parse = (query: object) =>
    sqlQuerySchema.safeParse({ source: "shop", from: "orders", ...query });

  it("takes a measure inside an aggregate and as a comparison value", () => {
    expect(
      parse({ select: [{ sum: { measure: "a" }, as: "x" }] }).success
    ).toBe(true);
    expect(
      parse({ select: ["id"], where: { d: { gt: { measure: "a" } } } }).success
    ).toBe(true);
    expect(
      parse({
        select: ["id"],
        where: { d: { between: [{ measure: "a" }, "2026-01-01"] } },
      }).success
    ).toBe(true);
  });

  it("refuses a measure in in, and a measure value with extra keys", () => {
    expect(
      parse({ select: ["id"], where: { d: { in: [{ measure: "a" }] } } })
        .success
    ).toBe(false);
    expect(
      parse({
        select: ["id"],
        where: { d: { gt: { measure: "a", as: "b" } } },
      }).success
    ).toBe(false);
  });

  it("refuses a measure that is not fixed inside an aggregate when planning", () => {
    expect(
      refusal({ select: [{ sum: { measure: "total_revenue" }, as: "x" }] })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["select", 0, "sum", "measure"],
    });
  });
});
