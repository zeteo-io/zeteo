// @module-tag unit
// @module-tag platform
import type { ColumnRef, SqlPlan } from "../../../adapters/sql/types.js";
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
    return {
      code: err.code,
      path: err.path,
      suggestions: err.suggestions,
      message: err.message,
    };
  }
  throw new Error("the query was planned");
};

const ref = (tableId: string, column: string) => ({
  tableId,
  columnId: `${tableId}.${column}`,
});

describe("planSql: the spec's example", () => {
  const example = {
    from: "orders",
    join: ["customer", { relation: "lines", type: "left" }],
    select: [
      "customer.region",
      { bucket: "month", column: "created_at", as: "month" },
      { sum: "total", as: "revenue" },
    ],
    where: { status: { in: ["paid", "shipped"] } },
    groupBy: ["customer.region", "month"],
    having: { revenue: { gt: 1000 } },
    orderBy: [{ revenue: "desc" }],
    limit: 1000,
    offset: 0,
  };

  it("resolves to the full plan the compiler needs", () => {
    const region: ColumnRef = {
      alias: "t1",
      name: "region",
      type: "text",
      nativeType: "text",
    };
    const createdAt: ColumnRef = {
      alias: "t0",
      name: "created_at",
      type: "timestamp",
      nativeType: "timestamp with time zone",
    };
    const total: ColumnRef = {
      alias: "t0",
      name: "total",
      type: "number",
      nativeType: "numeric(12,2)",
    };
    const status: ColumnRef = {
      alias: "t0",
      name: "status",
      type: "text",
      nativeType: "text",
    };
    expect(plan(example)).toEqual<SqlPlan>({
      from: { alias: "t0", schemaName: "shop", name: "orders" },
      joins: [
        {
          alias: "t1",
          relation: "customer",
          table: { schemaName: "shop", name: "customers" },
          type: "inner",
          on: [["t0", "customer_id", "id"]],
        },
        {
          alias: "t2",
          relation: "lines",
          table: { schemaName: "shop", name: "order_lines" },
          type: "left",
          on: [["t0", "id", "order_id"]],
        },
      ],
      select: [
        {
          kind: "column",
          column: region,
          output: "customer.region",
          type: "text",
        },
        {
          kind: "bucket",
          unit: "month",
          column: createdAt,
          output: "month",
          type: "timestamp",
        },
        {
          kind: "aggregate",
          fn: "sum",
          column: total,
          output: "revenue",
          type: "number",
        },
      ],
      distinct: false,
      where: {
        kind: "in",
        op: "in",
        subject: status,
        values: ["paid", "shipped"],
      },
      groupBy: [0, 1],
      having: {
        kind: "compare",
        op: "gt",
        subject: { index: 2, type: "number" },
        value: 1000,
      },
      orderBy: [{ target: { kind: "output", index: 2 }, direction: "desc" }],
      references: [
        ref("orders", "customer_id"),
        ref("customers", "id"),
        ref("orders", "id"),
        ref("order_lines", "order_id"),
        ref("customers", "region"),
        ref("orders", "created_at"),
        ref("orders", "total"),
        ref("orders", "status"),
      ],
      columns: [
        {
          name: "customer.region",
          type: "text",
          references: [ref("customers", "region")],
        },
        {
          name: "month",
          type: "timestamp",
          references: [ref("orders", "created_at")],
        },
        {
          name: "revenue",
          type: "number",
          references: [ref("orders", "total")],
        },
      ],
      warnings: [
        {
          code: "join_multiplies_rows",
          message: expect.stringContaining('"lines"'),
          path: ["join", 1],
        },
      ],
      limit: 1000,
      offset: 0,
    });
  });
});

describe("planSql: from", () => {
  it("takes a bare name unique among visible tables", () => {
    expect(plan({ from: "customers", select: ["id"] }).from).toEqual({
      alias: "t0",
      schemaName: "shop",
      name: "customers",
    });
  });

  it("takes schema.table", () => {
    expect(
      plan({ from: "billing.accounts", select: ["balance"] }).from.schemaName
    ).toBe("billing");
  });

  it("refuses an ambiguous bare name, suggesting the qualified names", () => {
    expect(refusal({ from: "accounts" })).toEqual({
      code: "not_found_or_not_accessible",
      path: ["from"],
      suggestions: ["billing.accounts", "shop.accounts"],
      message: 'Table "accounts" was not found or is not accessible',
    });
  });

  it("is unambiguous when the other table is not visible", () => {
    expect(
      plan(
        { from: "accounts", select: ["plan"] },
        shopCatalog({ hidden: ["billing_accounts"] })
      ).from.schemaName
    ).toBe("shop");
  });

  it("refuses an unknown table, suggesting close visible names", () => {
    expect(refusal({ from: "ordrs" })).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["from"],
      suggestions: ["orders"],
    });
  });

  it("refuses a missing table with missing_in_source", () => {
    expect(refusal({}, { missing: ["orders"] })).toMatchObject({
      code: "missing_in_source",
      path: ["from"],
    });
  });
});

describe("planSql: joins", () => {
  it("joins a relation reached through another", () => {
    const { joins } = plan({
      join: ["customer", "customer.account"],
      select: ["customer.account.plan"],
    });
    expect(joins[1]).toEqual({
      alias: "t2",
      relation: "customer.account",
      table: { schemaName: "shop", name: "accounts" },
      type: "inner",
      on: [["t1", "account_id", "id"]],
    });
  });

  it("refuses a relation whose parent is not an earlier join", () => {
    expect(refusal({ join: ["customer.account"] })).toMatchObject({
      code: "join_parent_missing",
      path: ["join", 0],
    });
    expect(
      refusal({ join: ["customer", { relation: "lines.order" }] })
    ).toMatchObject({
      code: "join_parent_missing",
      path: ["join", 1, "relation"],
    });
  });

  it("refuses an unknown relation, suggesting the table's relations", () => {
    expect(refusal({ join: ["custmer"] })).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["join", 0],
      suggestions: ["customer"],
    });
  });

  it("refuses a missing relation with missing_in_source", () => {
    expect(
      refusal({ join: ["customer"] }, { missing: ["orders.customer"] })
    ).toMatchObject({
      code: "missing_in_source",
      path: ["join", 0],
    });
  });

  it("refuses a column through a relation that is not joined", () => {
    expect(
      refusal({ join: ["lines"], select: ["customer.region"] })
    ).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["select", 0],
      message: 'Relation "customer" was not found or is not accessible',
    });
  });
});

describe("planSql: columns", () => {
  it("refuses an unknown column, suggesting close visible columns of that table", () => {
    expect(
      refusal({ join: ["customer"], select: ["customer.regoin"] })
    ).toEqual({
      code: "not_found_or_not_accessible",
      path: ["select", 0],
      suggestions: ["customer.region"],
      message: 'Column "customer.regoin" was not found or is not accessible',
    });
  });

  it("refuses a missing column with missing_in_source", () => {
    expect(
      refusal({ select: ["notes"] }, { missing: ["orders.notes"] })
    ).toMatchObject({
      code: "missing_in_source",
      path: ["select", 0],
    });
  });

  it.each([
    ["selected", { select: ["photo"] }, ["select", 0]],
    ["counted", { select: [{ count: "photo" }] }, ["select", 0, "count"]],
    ["filtered", { where: { photo: { isNull: true } } }, ["where", "photo"]],
  ])("refuses a column of type other when %s", (_, over, path) => {
    expect(
      refusal({ from: "customers", select: ["id"], ...over })
    ).toMatchObject({
      code: "column_not_queryable",
      path,
    });
  });
});

describe("planSql: operators and values", () => {
  it.each([
    ["status", "contains", "a"],
    ["status", "startsWith", "a"],
    ["status", "gt", "a"],
    ["total", "between", [1, "2.50"]],
    ["ordered_on", "gte", "2026-02-28"],
    ["created_at", "lt", "2026-11-12T10:00:00Z"],
    ["created_at", "lt", "2026-11-12T10:00:00.123+02:00"],
    ["customer.vip", "eq", true],
    ["customer.vip", "isNull", false],
    ["customer.prefs", "isNull", true],
    ["id", "in", [1, "9007199254740993"]],
  ])("accepts %s %s %j", (column, op, value) => {
    expect(() =>
      plan({ join: ["customer"], where: { [column]: { [op]: value } } })
    ).not.toThrow();
  });

  it.each([
    ["total", "contains", "1"],
    ["ordered_on", "startsWith", "2026"],
    ["created_at", "contains", "2026"],
    ["customer.vip", "gt", true],
    ["customer.vip", "in", [true]],
    ["customer.prefs", "eq", "x"],
  ])("refuses %s %s with invalid_operator", (column, op, value) => {
    expect(
      refusal({ join: ["customer"], where: { [column]: { [op]: value } } })
    ).toMatchObject({ code: "invalid_operator", path: ["where", column, op] });
  });

  it.each([
    ["total", "eq", "1e3", ["where", "total", "eq"]],
    ["total", "eq", "ten", ["where", "total", "eq"]],
    ["total", "eq", true, ["where", "total", "eq"]],
    ["status", "eq", 1, ["where", "status", "eq"]],
    ["ordered_on", "eq", "2026-02-30", ["where", "ordered_on", "eq"]],
    ["ordered_on", "eq", "2026-2-1", ["where", "ordered_on", "eq"]],
    ["created_at", "eq", "2026-11-12T10:00:00", ["where", "created_at", "eq"]],
    ["created_at", "eq", "2026-11-12 10:00:00Z", ["where", "created_at", "eq"]],
    ["created_at", "eq", "2026-11-12T25:00:00Z", ["where", "created_at", "eq"]],
    ["customer.vip", "eq", "true", ["where", "customer.vip", "eq"]],
    ["id", "in", [1, "x"], ["where", "id", "in", 1]],
    ["total", "between", [1, "x"], ["where", "total", "between", 1]],
  ])("refuses %s %s %j with invalid_value", (column, op, value, path) => {
    expect(
      refusal({ join: ["customer"], where: { [column]: { [op]: value } } })
    ).toMatchObject({ code: "invalid_value", path });
  });

  it("keeps a decimal string as given and a number as a number", () => {
    const { where } = plan({ where: { total: { between: ["10.50", 20] } } });
    expect(where).toMatchObject({ kind: "between", low: "10.50", high: 20 });
  });

  it("reads several paths in one object as and, and carries the path of nested filters", () => {
    expect(
      plan({ where: { status: { eq: "paid" }, id: { gt: 1 } } }).where
    ).toMatchObject({
      kind: "and",
      filters: [
        { kind: "compare", op: "eq", value: "paid" },
        { kind: "compare", op: "gt", value: 1 },
      ],
    });
    expect(
      refusal({ where: { and: [{ id: { eq: 1 } }, { status: { eq: 2 } }] } })
    ).toMatchObject({
      code: "invalid_value",
      path: ["where", "and", 1, "status", "eq"],
    });
    expect(
      refusal({ where: { or: [{ not: { stauts: { eq: "x" } } }] } })
    ).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["where", "or", 0, "not", "stauts"],
      suggestions: ["status"],
    });
  });
});

describe("planSql: aggregates and buckets", () => {
  it.each([
    [{ sum: "status" }, "sum"],
    [{ avg: "ordered_on" }, "avg"],
    [{ min: "customer.vip" }, "min"],
    [{ max: "customer.prefs" }, "max"],
  ])("refuses %j on a column of the wrong type", (item, fn) => {
    expect(refusal({ join: ["customer"], select: [item] })).toMatchObject({
      code: "invalid_operator",
      path: ["select", 0, fn],
    });
  });

  it("refuses a bucket on a column that is not a date or timestamp", () => {
    expect(
      refusal({ select: [{ bucket: "day", column: "status" }] })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["select", 0, "column"],
    });
  });

  it("accepts min and max on text, count on any queryable type, buckets on dates", () => {
    const { select } = plan({
      join: ["customer"],
      select: [
        { min: "status" },
        { max: "ordered_on" },
        { count: "customer.prefs" },
        { countDistinct: "customer.vip" },
        { bucket: "quarter", column: "ordered_on" },
      ],
      groupBy: ["quarter_ordered_on"],
    });
    expect(select.map((s) => s.type)).toEqual([
      "text",
      "date",
      "number",
      "number",
      "date",
    ]);
  });

  it("names outputs by alias, path, function and path, or unit and path", () => {
    const { columns } = plan({
      join: ["customer"],
      select: [
        "customer.region",
        { count: "*" },
        { count: "customer.id" },
        { countDistinct: "customer_id", as: "buyers" },
        { avg: "total" },
        { bucket: "week", column: "customer.created_at" },
      ],
      groupBy: ["customer.region", "week_customer_created_at"],
    });
    expect(columns.map((c) => c.name)).toEqual([
      "customer.region",
      "count",
      "count_customer_id",
      "buyers",
      "avg_total",
      "week_customer_created_at",
    ]);
  });

  it("refuses two select items with one output name", () => {
    expect(refusal({ select: ["id", { count: "*", as: "id" }] })).toMatchObject(
      {
        code: "duplicate_output_name",
        path: ["select", 1, "as"],
      }
    );
    expect(refusal({ select: ["id", "id"] })).toMatchObject({
      code: "duplicate_output_name",
      path: ["select", 1],
    });
  });

  it("warns that a to-many join multiplies rows under an aggregate", () => {
    expect(
      plan({ join: ["lines"], select: [{ count: "*" }] }).warnings
    ).toEqual([
      expect.objectContaining({
        code: "join_multiplies_rows",
        path: ["join", 0],
      }),
    ]);
    expect(plan({ join: ["lines"], select: ["lines.sku"] }).warnings).toEqual(
      []
    );
    expect(
      plan({ join: ["customer"], select: [{ count: "*" }] }).warnings
    ).toEqual([]);
  });
});

describe("planSql: grouping and having", () => {
  it("refuses a plain select item missing from groupBy when grouped", () => {
    expect(refusal({ select: ["status", { count: "*" }] })).toMatchObject({
      code: "invalid_grouping",
      path: ["select", 0],
    });
    expect(
      refusal({ select: ["status", "notes"], groupBy: ["status"] })
    ).toMatchObject({ code: "invalid_grouping", path: ["select", 1] });
  });

  it("refuses a groupBy entry that is not a select item or that is an aggregate", () => {
    expect(
      refusal({
        select: ["status", { count: "*" }],
        groupBy: ["status", "notes"],
      })
    ).toMatchObject({ code: "invalid_grouping", path: ["groupBy", 1] });
    expect(
      refusal({
        select: ["status", { count: "*" }],
        groupBy: ["status", "count"],
      })
    ).toMatchObject({ code: "invalid_grouping", path: ["groupBy", 1] });
  });

  it("groups a bucket by its output name or its column path", () => {
    const byPath = plan({
      select: [{ bucket: "year", column: "created_at" }, { count: "*" }],
      groupBy: ["created_at"],
    });
    expect(byPath.groupBy).toEqual([0]);
  });

  it("groups without aggregates", () => {
    expect(plan({ select: ["status"], groupBy: ["status"] }).groupBy).toEqual([
      0,
    ]);
  });

  it("refuses having on a name that is not an aggregate's output", () => {
    const grouped = { select: ["status", { count: "*" }], groupBy: ["status"] };
    expect(
      refusal({ ...grouped, having: { status: { eq: "x" } } })
    ).toMatchObject({
      code: "invalid_having",
      path: ["having", "status"],
    });
    expect(
      refusal({
        ...grouped,
        having: { and: [{ count: { gt: 1 } }, { total: { gt: 1 } }] },
      })
    ).toMatchObject({
      code: "invalid_having",
      path: ["having", "and", 1, "total"],
    });
  });

  it("refuses having without aggregates", () => {
    expect(
      refusal({
        select: ["status"],
        groupBy: ["status"],
        having: { status: { eq: "x" } },
      })
    ).toMatchObject({ code: "invalid_having", path: ["having"] });
  });

  it("checks having operators and values against the aggregate's type", () => {
    const grouped = {
      select: ["status", { max: "ordered_on" }],
      groupBy: ["status"],
    };
    expect(
      plan({ ...grouped, having: { max_ordered_on: { gt: "2026-01-01" } } })
        .having
    ).toEqual({
      kind: "compare",
      op: "gt",
      subject: { index: 1, type: "date" },
      value: "2026-01-01",
    });
    expect(
      refusal({ ...grouped, having: { max_ordered_on: { gt: 5 } } })
    ).toMatchObject({
      code: "invalid_value",
      path: ["having", "max_ordered_on", "gt"],
    });
    expect(
      refusal({ ...grouped, having: { max_ordered_on: { contains: "5" } } })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["having", "max_ordered_on", "contains"],
    });
  });
});

describe("planSql: order", () => {
  it("orders by the select items in order when the query gives none", () => {
    expect(plan({ select: ["status", "id"] }).orderBy).toEqual([
      { target: { kind: "output", index: 0 }, direction: "asc" },
      { target: { kind: "output", index: 1 }, direction: "asc" },
    ]);
  });

  it("prefers an output name over a column path", () => {
    expect(
      plan({
        select: ["id", { count: "*", as: "status" }],
        groupBy: ["id"],
        orderBy: [{ status: "desc" }],
      }).orderBy
    ).toEqual([{ target: { kind: "output", index: 1 }, direction: "desc" }]);
  });

  it("orders by a column that is not selected when neither grouped nor distinct", () => {
    const planned = plan({ select: ["id"], orderBy: [{ notes: "asc" }] });
    expect(planned.orderBy).toEqual([
      {
        target: {
          kind: "column",
          column: {
            alias: "t0",
            name: "notes",
            type: "text",
            nativeType: "text",
          },
        },
        direction: "asc",
      },
    ]);
    expect(planned.references).toContainEqual(ref("orders", "notes"));
  });

  it.each([
    ["grouped", { select: ["status"], groupBy: ["status"] }],
    ["distinct", { select: ["status"], distinct: true }],
  ])("refuses an unselected column when %s", (_, over) => {
    expect(
      refusal({ ...over, orderBy: [{ id: "asc" }, { notes: "asc" }] })
    ).toMatchObject({
      code: "invalid_order",
      path: ["orderBy", 0, "id"],
    });
  });
});

describe("planSql: references, columns and paging", () => {
  it("lists every column touched once, join keys of both sides included", () => {
    const { references } = plan({
      join: ["customer"],
      select: ["id", "customer.id"],
      where: { id: { gt: 1 }, "customer.id": { gt: 1 } },
      orderBy: [{ id: "asc" }],
    });
    expect(references).toEqual([
      ref("orders", "customer_id"),
      ref("customers", "id"),
      ref("orders", "id"),
    ]);
  });

  it("references nothing for count(*) beyond the joins", () => {
    expect(plan({ select: [{ count: "*" }] }).references).toEqual([]);
    expect(plan({ select: [{ count: "*" }] }).columns).toEqual([
      { name: "count", type: "number", references: [] },
    ]);
    expect(
      plan({ join: ["customer"], select: [{ count: "*" }] }).references
    ).toEqual([ref("orders", "customer_id"), ref("customers", "id")]);
  });

  it("carries limit and offset, offset defaulting to 0", () => {
    expect(plan({})).toMatchObject({
      limit: undefined,
      offset: 0,
      distinct: false,
    });
    expect(plan({ limit: 5, offset: 10, distinct: true })).toMatchObject({
      limit: 5,
      offset: 10,
      distinct: true,
    });
  });
});

describe("planSql: suggestions", () => {
  it("suggests close visible names of the table the path points into", () => {
    const { suggestions } = refusal({ from: "customers", select: ["nme"] });
    expect(suggestions).toEqual(["name"]);
  });

  it("suggests nothing when no visible name is close", () => {
    expect(refusal({ select: ["zzzzzzzzzzzz"] }).suggestions).toEqual([]);
  });
});
