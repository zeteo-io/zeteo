// @module-tag unit
// @module-tag platform
import { measure, metricsCatalog } from "../../support/pure/metricsCatalog.js";
import type { RowRule, RuleColumn } from "../../../row-rules/resolve.js";
import type { QueryableType } from "../../../adapters/sql/types.js";
import { resolveRelative } from "../../../adapters/sql/relative.js";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { sqlLanguage } from "../../../adapters/sql/language.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import {
  shopCatalog,
  type ShopOptions,
} from "../../support/pure/shopCatalog.js";
import type {
  MetricPlan,
  SqlPlan,
  TablePlan,
} from "../../../adapters/sql/types.js";

// A caller's row rule on a table is put into the plan wherever the table is
// read: the query's from, each join (a measure's to-one joins too), a fixed
// measure's own table and joins, and each metric part's. Its columns are read
// by id from the rule, never from the caller's grants, and never become a
// reference.

const NOW = new Date("2026-06-15T12:00:00Z");

/** A rule column of the shop, by id (`<table key>.<column>`). */
const ruleColumn = (
  id: string,
  type: QueryableType,
  nativeType: string
): RuleColumn => ({ id, name: id.split(".")[1]!, type, nativeType });

const STATUS = ruleColumn("orders.status", "text", "text");
const REGION = ruleColumn("customers.region", "text", "text");
const CUSTOMER_ID = ruleColumn("orders.customer_id", "number", "integer");
const CREATED_AT = ruleColumn(
  "orders.created_at",
  "timestamp",
  "timestamp with time zone"
);
const NOTES = ruleColumn("orders.notes", "text", "text");
const SKU = ruleColumn("order_lines.sku", "text", "text");

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

const PAID = rule({ "orders.status": { in: ["paid"] } }, [STATUS]);
const EU = rule({ "customers.region": { eq: "EU" } }, [REGION]);

const plan = (query: object, options: ShopOptions = {}): SqlPlan =>
  sqlLanguage.plan(
    sqlLanguage.schema.parse({ source: "shop", ...query }),
    shopCatalog(options),
    { now: NOW }
  ) as SqlPlan;

const table = (query: object, options: ShopOptions = {}): TablePlan =>
  plan({ from: "orders", select: ["id"], ...query }, options) as TablePlan;

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      path: err.path,
      suggestions: err.suggestions,
    };
  }
  throw new Error("expected a refusal");
};

describe("planSql: row rules", () => {
  it("puts a rule on the from table into the plan and marks its rows limited", () => {
    const p = table({}, { rowRules: { orders: PAID } });
    expect(p.from.rowFilter).toEqual({
      kind: "in",
      op: "in",
      subject: { name: "status", type: "text", nativeType: "text" },
      values: ["paid"],
    });
    expect(p.rowsLimited).toBe(true);
  });

  it("leaves a plan with no rule as it was, its rows not limited", () => {
    const p = table({ join: ["customer"], select: ["id", "customer.name"] });
    expect(p.from).toEqual({ alias: "t0", schemaName: "shop", name: "orders" });
    expect(p.joins[0]).not.toHaveProperty("rowFilter");
    expect(p.rowsLimited).toBe(false);
  });

  it("puts a rule on a joined table on its join, inner or left", () => {
    for (const join of [
      ["customer"],
      [{ relation: "customer", type: "left" }],
    ]) {
      const p = table(
        { join, select: ["id", "customer.name"] },
        { rowRules: { customers: EU } }
      );
      expect(p.from).not.toHaveProperty("rowFilter");
      expect(p.joins[0]!.rowFilter).toEqual({
        kind: "compare",
        op: "eq",
        subject: { name: "region", type: "text", nativeType: "text" },
        value: "EU",
      });
      expect(p.rowsLimited).toBe(true);
    }
  });

  it("puts a rule on a to-many join's table", () => {
    const p = table(
      { join: ["lines"], select: ["id", "lines.sku"] },
      {
        rowRules: {
          order_lines: rule({ "order_lines.sku": { startsWith: "A" } }, [SKU]),
        },
      }
    );
    expect(p.joins[0]!.rowFilter).toMatchObject({
      kind: "match",
      op: "startsWith",
      value: "A",
    });
  });

  it("plans a rule that keeps no row as never", () => {
    const p = table({}, { rowRules: { orders: { kind: "never" } } });
    expect(p.from.rowFilter).toEqual({ kind: "never" });
    expect(p.rowsLimited).toBe(true);
  });

  it("refuses a table whose rule cannot be applied, from or joined, with 409", () => {
    for (const reason of ["column_missing", "too_many_values"] as const) {
      const unavailable: RowRule = { kind: "unavailable", reason };
      expect(
        refusal(() => table({}, { rowRules: { orders: unavailable } }))
      ).toEqual({
        status: 409,
        code: "row_rule_unavailable",
        message:
          "Your access to orders can't be applied right now; ask an admin",
        path: ["from"],
        suggestions: [],
      });
      expect(
        refusal(() =>
          table(
            { join: ["customer"], select: ["id"] },
            { rowRules: { customers: unavailable } }
          )
        )
      ).toMatchObject({
        status: 409,
        code: "row_rule_unavailable",
        message:
          "Your access to customers can't be applied right now; ask an admin",
        path: ["join", 0],
      });
    }
  });

  it("refuses a rule whose column no longer fits it as unavailable, never unfiltered", () => {
    // The column's type changed since the rule was written: contains on a number.
    const drifted = rule({ "orders.customer_id": { contains: "1" } }, [
      CUSTOMER_ID,
    ]);
    expect(
      refusal(() => table({}, { rowRules: { orders: drifted } }))
    ).toMatchObject({ status: 409, code: "row_rule_unavailable" });
    // A column the rule names but did not load.
    const unloaded = rule({ "orders.status": { eq: "paid" } }, []);
    expect(
      refusal(() => table({}, { rowRules: { orders: unloaded } }))
    ).toMatchObject({ status: 409, code: "row_rule_unavailable" });
  });

  it("binds identity values given as text as the column's type", () => {
    const p = table(
      {},
      {
        rowRules: {
          orders: rule({ "orders.customer_id": { in: ["1042", "7"] } }, [
            CUSTOMER_ID,
          ]),
        },
      }
    );
    expect(p.from.rowFilter).toEqual({
      kind: "in",
      op: "in",
      subject: { name: "customer_id", type: "number", nativeType: "integer" },
      values: ["1042", "7"],
    });
  });

  it("resolves a relative date in a rule against the plan's now", () => {
    const p = table(
      {},
      {
        rowRules: {
          orders: rule(
            {
              "orders.created_at": {
                gte: { relative: { unit: "day", offset: -90 } },
              },
            },
            [CREATED_AT]
          ),
        },
      }
    );
    expect(p.from.rowFilter).toMatchObject({
      kind: "compare",
      op: "gte",
      value: resolveRelative(
        { relative: { unit: "day", offset: -90 } },
        NOW,
        DEFAULT_CALENDAR
      ).toISOString(),
    });
  });

  it("plans isBusinessDay in a rule with the calendar, as in where", () => {
    const p = table(
      {},
      {
        rowRules: {
          orders: rule({ "orders.created_at": { isBusinessDay: true } }, [
            CREATED_AT,
          ]),
        },
      }
    );
    const where = table({
      where: { created_at: { isBusinessDay: true } },
    }).where as { calendar: unknown };
    expect(p.from.rowFilter).toEqual({
      kind: "businessDay",
      subject: {
        name: "created_at",
        type: "timestamp",
        nativeType: "timestamp with time zone",
      },
      is: true,
      calendar: where.calendar,
    });
  });

  it("keeps rule columns out of the plan's references", () => {
    const p = table(
      { select: ["id"] },
      {
        hidden: ["orders.notes"],
        rowRules: {
          orders: rule({ "orders.notes": { isNull: false } }, [NOTES]),
        },
      }
    );
    expect(p.references.map((r) => r.columnId)).toEqual(["orders.id"]);
    expect(p.columns[0]!.references).toEqual([
      { tableId: "orders", columnId: "orders.id" },
    ]);
  });

  it("refuses an ungranted rule column in select, where and orderBy, never suggesting it", () => {
    const options: ShopOptions = {
      hidden: ["orders.notes"],
      rowRules: { orders: rule({ "orders.notes": { eq: "x" } }, [NOTES]) },
    };
    for (const query of [
      { select: ["notes"] },
      { select: ["id"], where: { notes: { eq: "x" } } },
      { select: ["id"], orderBy: [{ notes: "asc" }] },
      { select: ["note"] },
    ]) {
      const refused = refusal(() => table(query, options));
      expect(refused.code).toBe("not_found_or_not_accessible");
      expect(refused.suggestions).not.toContain("notes");
    }
  });

  it("puts the rule of a table a measure joins on the measure's join", () => {
    const p = table(
      { select: [{ measure: "eu_revenue" }] },
      {
        measures: [
          measure(
            "eu_revenue",
            { sum: "total" },
            {
              where: { "customer.region": { eq: "EU" } },
            }
          ),
        ],
        rowRules: { customers: EU },
      }
    );
    expect(p.joins).toHaveLength(1);
    expect(p.joins[0]!.rowFilter).toMatchObject({ kind: "compare" });
  });

  it("puts the rule on a fixed measure's own table, and marks the query limited from a table with none", () => {
    const p = plan(
      {
        from: "customers",
        select: ["name", { measure: "paid_count" }],
        groupBy: ["name"],
      },
      {
        measures: [measure("paid_count", { count: "*" }, { fixed: true })],
        rowRules: { orders: PAID },
      }
    ) as TablePlan;
    expect(p.from).not.toHaveProperty("rowFilter");
    const scalar = p.select[1]!.kind === "calc" ? p.select[1]!.expr : undefined;
    expect(scalar).toMatchObject({
      kind: "scalar",
      plan: {
        from: {
          alias: "f1_t0",
          name: "orders",
          rowFilter: { kind: "in", values: ["paid"] },
        },
      },
    });
    expect(p.rowsLimited).toBe(true);
  });

  it("puts the rule on a fixed measure's joins", () => {
    const p = plan(
      {
        from: "products",
        select: ["name", { measure: "eu_orders" }],
        groupBy: ["name"],
      },
      {
        measures: [
          measure(
            "eu_orders",
            { count: "*" },
            {
              fixed: true,
              where: { "customer.region": { eq: "EU" } },
            }
          ),
        ],
        rowRules: { customers: EU },
      }
    ) as TablePlan;
    const scalar = (p.select[1] as { expr: { plan: { joins: unknown[] } } })
      .expr;
    expect(scalar.plan.joins[0]).toMatchObject({
      alias: "f1_t1",
      rowFilter: { kind: "compare", value: "EU" },
    });
    expect(p.rowsLimited).toBe(true);
  });

  it("puts the rule on each metric part's table and joins", () => {
    const p = sqlLanguage.plan(
      sqlLanguage.schema.parse({
        source: "shop",
        metrics: ["revenue", "line_value"],
        bucket: "month",
      }),
      metricsCatalog({
        rowRules: {
          orders: PAID,
          products: rule({ "products.name": { ne: "x" } }, [
            ruleColumn("products.name", "text", "text"),
          ]),
        },
      }),
      { now: NOW }
    ) as MetricPlan;
    expect(p.parts[0]!.from.rowFilter).toMatchObject({ kind: "in" });
    // line_value: order_lines, joined to product for its date column.
    expect(p.parts[1]!.from).not.toHaveProperty("rowFilter");
    expect(p.parts[1]!.joins[0]!.rowFilter).toMatchObject({ kind: "compare" });
    expect(p.rowsLimited).toBe(true);
  });

  it("marks a metric query with no rule anywhere as not limited", () => {
    const p = sqlLanguage.plan(
      sqlLanguage.schema.parse({ source: "shop", metrics: ["revenue"] }),
      metricsCatalog(),
      { now: NOW }
    ) as MetricPlan;
    expect(p.rowsLimited).toBe(false);
  });

  it("marks a metric query limited when only a fixed measure's table has a rule", () => {
    const p = sqlLanguage.plan(
      sqlLanguage.schema.parse({ source: "shop", metrics: ["top_balance"] }),
      metricsCatalog({
        rowRules: {
          billing_accounts: rule({ "billing_accounts.id": { gt: 1 } }, [
            ruleColumn("billing_accounts.id", "number", "integer"),
          ]),
        },
      }),
      { now: NOW }
    ) as MetricPlan;
    expect(p.parts).toHaveLength(0);
    expect(p.rowsLimited).toBe(true);
  });
});
