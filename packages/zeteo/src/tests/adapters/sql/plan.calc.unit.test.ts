// @module-tag unit
// @module-tag platform
import type { ColumnRef, ResolvedSelect } from "../../../adapters/sql/types.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import {
  shopCatalog,
  type ShopOptions,
} from "../../support/pure/shopCatalog.js";

const plan = (query: object, catalog: VisibleCatalog = shopCatalog()) =>
  planSql(
    sqlQuerySchema.parse({
      source: "shop",
      from: "orders",
      select: ["id"],
      ...query,
    }),
    catalog
  );

const refusal = (query: object, options?: ShopOptions) => {
  try {
    plan(query, shopCatalog(options));
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return { code: err.code, path: err.path, message: err.message };
  }
  throw new Error("the query was planned");
};

const ref = (tableId: string, column: string) => ({
  tableId,
  columnId: `${tableId}.${column}`,
});

const col = (
  alias: string,
  name: string,
  type: ColumnRef["type"],
  nativeType: string
) => ({ kind: "column" as const, column: { alias, name, type, nativeType } });

const LINE_TOTAL = {
  calc: { mul: ["lines.price", "lines.quantity"] },
  as: "line_total",
};

describe("planSql: row-level calculations", () => {
  it("plans a line total as a row-level calc reading both columns", () => {
    const { select, columns, groupBy, references } = plan({
      join: ["lines"],
      select: ["id", LINE_TOTAL],
    });
    expect(select[1]).toEqual<ResolvedSelect>({
      kind: "calc",
      level: "row",
      expr: {
        kind: "op",
        op: "mul",
        args: [
          col("t1", "price", "number", "numeric(12,2)"),
          col("t1", "quantity", "number", "integer"),
        ],
        type: "number",
      },
      output: "line_total",
      type: "number",
    });
    expect(groupBy).toEqual([]);
    expect(columns[1]).toEqual({
      name: "line_total",
      type: "number",
      references: [ref("order_lines", "price"), ref("order_lines", "quantity")],
    });
    expect(references).toEqual(
      expect.arrayContaining([
        ref("order_lines", "price"),
        ref("order_lines", "quantity"),
      ])
    );
  });

  it("plans literals, round with and without places, concat, lower and coalesce", () => {
    const { select } = plan({
      join: ["customer"],
      select: [
        { calc: { round: [{ div: ["total", 3] }, 2] }, as: "third" },
        { calc: { round: "total" }, as: "whole" },
        {
          calc: { concat: ["customer.name", { value: " #" }, "id"] },
          as: "label",
        },
        { calc: { upper: { coalesce: ["notes", { value: "-" }] } }, as: "n" },
        { calc: { abs: { sub: ["total", 10] } }, as: "off" },
        { calc: { coalesce: ["ordered_on", "ordered_on"] }, as: "day" },
      ],
    });
    expect(select.map((s) => [s.kind, s.type])).toEqual([
      ["calc", "number"],
      ["calc", "number"],
      ["calc", "text"],
      ["calc", "text"],
      ["calc", "number"],
      ["calc", "date"],
    ]);
    expect(select[0]).toMatchObject({
      expr: {
        kind: "op",
        op: "round",
        places: 2,
        args: [
          {
            kind: "op",
            op: "div",
            args: [
              { kind: "column" },
              { kind: "literal", value: 3, type: "number" },
            ],
          },
        ],
      },
    });
    expect(select[1]).toMatchObject({
      expr: { kind: "op", op: "round", places: 0, args: [{ kind: "column" }] },
    });
    expect(select[2]).toMatchObject({
      expr: {
        op: "concat",
        args: [{}, { kind: "literal", value: " #", type: "text" }, {}],
      },
    });
  });

  it("is filtered in where by its name, as the calc itself", () => {
    const { where } = plan({
      join: ["lines"],
      select: ["id", LINE_TOTAL],
      where: { line_total: { gt: 100 } },
    });
    expect(where).toEqual({
      kind: "compare",
      op: "gt",
      subject: { index: 1, type: "number" },
      value: 100,
    });
  });

  it("checks where operators and values against the calc's type", () => {
    expect(
      refusal({
        join: ["lines"],
        select: ["id", LINE_TOTAL],
        where: { line_total: { contains: "1" } },
      })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["where", "line_total", "contains"],
    });
  });

  it("is grouped by its name and must be grouped when the query is", () => {
    const query = {
      select: [{ calc: { lower: "status" }, as: "s" }, { count: "*" }],
    };
    expect(plan({ ...query, groupBy: ["s"] }).groupBy).toEqual([0]);
    expect(refusal(query)).toMatchObject({
      code: "invalid_grouping",
      path: ["select", 0],
    });
  });

  it("cannot be grouped by a column path it reads", () => {
    expect(
      refusal({
        select: [{ calc: { lower: "status" }, as: "s" }, { count: "*" }],
        groupBy: ["status"],
      })
    ).toMatchObject({ code: "invalid_grouping", path: ["groupBy", 0] });
  });
});

describe("planSql: group-level calculations", () => {
  it("plans revenue by category through four joins", () => {
    const result = plan({
      join: ["customer", "lines", "lines.product", "lines.product.category"],
      select: [
        "lines.product.category.name",
        { sum: { mul: ["lines.price", "lines.quantity"] }, as: "revenue" },
      ],
      where: { "customer.region": { eq: "north" } },
      groupBy: ["lines.product.category.name"],
    });
    expect(result.select[1]).toEqual<ResolvedSelect>({
      kind: "calc",
      level: "group",
      expr: {
        kind: "aggregate",
        fn: "sum",
        arg: {
          kind: "op",
          op: "mul",
          args: [
            col("t2", "price", "number", "numeric(12,2)"),
            col("t2", "quantity", "number", "integer"),
          ],
          type: "number",
        },
        type: "number",
      },
      output: "revenue",
      type: "number",
    });
    expect(result.groupBy).toEqual([0]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "join_multiplies_rows",
        path: ["join", 1],
      }),
    ]);
    expect(result.columns[1].references).toEqual([
      ref("order_lines", "price"),
      ref("order_lines", "quantity"),
    ]);
  });

  it("plans a margin as a division of two sums, needing no groupBy", () => {
    const { select, groupBy } = plan({
      join: ["lines", "lines.product"],
      select: [
        {
          calc: {
            mul: [
              100,
              {
                div: [
                  { sum: { sub: ["lines.price", "lines.product.cost"] } },
                  { sum: "lines.price" },
                ],
              },
            ],
          },
          as: "margin",
        },
      ],
    });
    expect(select[0]).toMatchObject({
      kind: "calc",
      level: "group",
      type: "number",
      output: "margin",
      expr: {
        kind: "op",
        op: "mul",
        args: [
          { kind: "literal", value: 100 },
          {
            kind: "op",
            op: "div",
            args: [
              { kind: "aggregate", fn: "sum", arg: { kind: "op", op: "sub" } },
              { kind: "aggregate", fn: "sum", arg: { kind: "column" } },
            ],
          },
        ],
      },
    });
    expect(groupBy).toEqual([]);
  });

  it("types counts as numbers and min and max as their operand", () => {
    const { select } = plan({
      select: [
        {
          calc: { div: [{ sum: "total" }, { countDistinct: "customer_id" }] },
          as: "aov",
        },
        { calc: { add: [{ count: "*" }, 1] }, as: "n" },
        { calc: { lower: { max: "status" } }, as: "top" },
        { min: { coalesce: ["ordered_on", "ordered_on"] }, as: "first" },
      ],
    });
    expect(select.map((s) => [s.kind, s.type])).toEqual([
      ["calc", "number"],
      ["calc", "number"],
      ["calc", "text"],
      ["calc", "date"],
    ]);
    expect(select[1]).toMatchObject({
      expr: { args: [{ kind: "aggregate", fn: "count", arg: "*" }, {}] },
    });
  });

  it("keeps a plain-path aggregate as an aggregate item", () => {
    expect(plan({ select: [{ sum: "total" }] }).select[0].kind).toBe(
      "aggregate"
    );
  });

  it("makes a plain select item need groupBy", () => {
    expect(
      refusal({
        select: ["status", { calc: { abs: { sum: "total" } }, as: "t" }],
      })
    ).toMatchObject({ code: "invalid_grouping", path: ["select", 0] });
  });

  it("is accepted in having and refused in groupBy", () => {
    const query = {
      select: ["status", { calc: { abs: { sum: "total" } }, as: "t" }],
      groupBy: ["status"],
    };
    expect(plan({ ...query, having: { t: { gt: 5 } } }).having).toEqual({
      kind: "compare",
      op: "gt",
      subject: { index: 1, type: "number" },
      value: 5,
    });
    expect(refusal({ ...query, groupBy: ["status", "t"] })).toMatchObject({
      code: "invalid_grouping",
      path: ["groupBy", 1],
    });
  });

  it("allows having with only a group-level calc as the aggregate", () => {
    expect(
      plan({
        select: [{ calc: { mul: [{ sum: "total" }, 2] }, as: "t" }],
        having: { t: { gt: 1 } },
      }).having
    ).toMatchObject({ subject: { index: 0 } });
  });

  it("refuses a group-level calc or an aggregate named in where, pointing to having", () => {
    for (const item of [
      { calc: { abs: { sum: "total" } }, as: "t" },
      { sum: { abs: "total" }, as: "t" },
      { sum: "total", as: "t" },
    ]) {
      const refused = refusal({
        select: [item],
        where: { t: { gt: 5 } },
      });
      expect(refused).toMatchObject({
        code: "invalid_grouping",
        path: ["where", "t"],
      });
      expect(refused.message).toContain("having");
    }
  });

  it("warns of a to-many join under a group-level calc as under an aggregate", () => {
    expect(
      plan({
        join: ["lines"],
        select: [{ calc: { abs: { sum: "lines.price" } }, as: "t" }],
      }).warnings
    ).toEqual([
      expect.objectContaining({
        code: "join_multiplies_rows",
        path: ["join", 0],
      }),
    ]);
    expect(
      plan({ join: ["lines"], select: ["id", LINE_TOTAL] }).warnings
    ).toEqual([]);
  });
});

describe("planSql: calculations by name", () => {
  it("orders by a row-level and a group-level calc", () => {
    const { orderBy } = plan({
      select: [
        { calc: { lower: "status" }, as: "s" },
        { calc: { div: [{ sum: "total" }, { count: "*" }] }, as: "aov" },
      ],
      groupBy: ["s"],
      orderBy: [{ aov: "desc" }, { s: "asc" }],
    });
    expect(orderBy).toEqual([
      { target: { kind: "output", index: 1 }, direction: "desc" },
      { target: { kind: "output", index: 0 }, direction: "asc" },
    ]);
  });

  it("refuses a where key that is both a calc's name and a column path", () => {
    for (const item of [
      { calc: { lower: "status" }, as: "notes" },
      { sum: "total", as: "notes" },
    ]) {
      const refused = refusal({
        select: [item],
        where: { notes: { eq: "x" } },
      });
      expect(refused).toMatchObject({
        code: "duplicate_output_name",
        path: ["where", "notes"],
      });
      expect(refused.message).toContain("as");
    }
  });

  it("filters a column whose name a bucket shares as the column", () => {
    expect(
      plan({
        select: [{ bucket: "day", column: "ordered_on", as: "notes" }],
        where: { notes: { eq: "x" } },
      }).where
    ).toMatchObject({ subject: { alias: "t0", name: "notes" } });
  });

  it("names the output by as and refuses a duplicate at as", () => {
    expect(
      refusal({ select: ["id", { calc: { abs: "total" }, as: "id" }] })
    ).toMatchObject({
      code: "duplicate_output_name",
      path: ["select", 1, "as"],
    });
  });
});

describe("planSql: calculation refusals", () => {
  it("refuses a column outside an aggregate beside one inside, at the bare column", () => {
    expect(
      refusal({
        from: "order_lines",
        select: [{ calc: { add: ["price", { sum: "quantity" }] }, as: "x" }],
      })
    ).toMatchObject({
      code: "invalid_grouping",
      path: ["select", 0, "calc", "add", 0],
    });
  });

  it.each([
    [{ lower: "total" }, ["lower"]],
    [{ upper: { value: "a" } }, null],
    [{ add: ["total", "status"] }, ["add", 1]],
    [{ mul: ["total", { value: "2" }] }, ["mul", 1]],
    [{ abs: "ordered_on" }, ["abs"]],
    [{ round: ["status", 2] }, ["round", 0]],
    [{ concat: ["status", "ordered_on"] }, ["concat", 1]],
    [{ concat: ["status", "created_at"] }, ["concat", 1]],
    [{ coalesce: ["status", "total"] }, ["coalesce", 1]],
    [{ coalesce: ["total", { value: "0" }] }, ["coalesce", 1]],
    [{ coalesce: [{ value: "0" }, "notes"] }, null],
    [{ coalesce: [0, "total"] }, null],
    [{ sum: { lower: "status" } }, ["sum"]],
    [{ min: { coalesce: ["customer.vip", "customer.vip"] } }, ["min"]],
    [{ countDistinct: "customer.prefs" }, ["countDistinct"]],
  ])("types %j", (calc, at) => {
    const query = { join: ["customer"], select: [{ calc, as: "x" }] };
    if (at === null) {
      expect(plan(query).select[0].kind).toBe("calc");
    } else {
      expect(refusal(query)).toMatchObject({
        code: "invalid_operator",
        path: ["select", 0, "calc", ...at],
      });
    }
  });

  it("refuses an expression aggregate over the wrong type at its operand", () => {
    expect(
      refusal({ select: [{ sum: { lower: "status" }, as: "x" }] })
    ).toMatchObject({ code: "invalid_operator", path: ["select", 0, "sum"] });
    expect(
      refusal({
        select: [{ avg: { mul: ["total", "status"] }, as: "x" }],
      })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["select", 0, "avg", "mul", 1],
    });
  });

  it("refuses an ungranted operand at its path, as one that does not exist", () => {
    expect(
      refusal(
        { select: [{ calc: { mul: [2, "total"] }, as: "x" }] },
        { hidden: ["orders.total"] }
      )
    ).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["select", 0, "calc", "mul", 1],
    });
    expect(
      refusal(
        {
          join: ["lines"],
          select: [
            { sum: { mul: ["lines.price", "lines.quantity"] }, as: "x" },
          ],
        },
        { hidden: ["order_lines.quantity"] }
      )
    ).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["select", 0, "sum", "mul", 1],
    });
  });

  it("refuses a json calc where json cannot go", () => {
    expect(
      refusal({
        from: "customers",
        select: [{ calc: { coalesce: ["prefs", "prefs"] }, as: "p" }],
        orderBy: [{ p: "asc" }],
      })
    ).toMatchObject({ code: "invalid_operator", path: ["orderBy", 0, "p"] });
  });
});

describe("planSql: calculation references", () => {
  it("lists every operand column in references and in its column", () => {
    const { references, columns } = plan({
      join: ["customer", "lines"],
      select: [
        {
          calc: { concat: ["customer.name", { lower: "customer.email" }] },
          as: "who",
        },
        {
          calc: {
            div: [{ sum: "lines.price" }, { countDistinct: "lines.sku" }],
          },
          as: "avg_line",
        },
      ],
      groupBy: ["who"],
    });
    expect(columns.map((c) => c.references)).toEqual([
      [ref("customers", "name"), ref("customers", "email")],
      [ref("order_lines", "price"), ref("order_lines", "sku")],
    ]);
    expect(references).toEqual(
      expect.arrayContaining([
        ref("customers", "name"),
        ref("customers", "email"),
        ref("order_lines", "price"),
        ref("order_lines", "sku"),
      ])
    );
  });
});
