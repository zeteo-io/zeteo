// @module-tag unit
// @module-tag platform
import { resolveRelative } from "../../../adapters/sql/relative.js";
import type { MetricPlan } from "../../../adapters/sql/types.js";
import { fingerprintOf } from "../../../engine/fingerprint.js";
import { visibleMetrics } from "../../../measures/visible.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import {
  MEASURES,
  measure,
  metric,
  metricsCatalog,
} from "../../support/pure/metricsCatalog.js";
import {
  metricQuerySchema,
  sqlLanguage,
  sqlQuerySchema,
} from "../../../adapters/sql/language.js";
import type {
  MetricRow,
  VisibleCatalog,
} from "../../../grants/visibleCatalog.js";
import {
  MAX_METRIC_MEASURES,
  metricFormulaMeasures,
  metricFormulaProblem,
} from "../../../adapters/sql/metrics.js";

// A metric query asks for metrics and measures by name; each distinct
// non-fixed measure is a part bucketed and ranged by its own date column.

const NOW = new Date("2026-06-15T12:00:00Z");

const plan = (
  query: object,
  catalog: VisibleCatalog = metricsCatalog()
): MetricPlan =>
  sqlLanguage.plan(
    sqlLanguage.schema.parse({ source: "shop", ...query }),
    catalog,
    { now: NOW }
  ) as MetricPlan;

/** Every field of the refusal planning `query` gets. */
const refusal = (query: object, catalog?: VisibleCatalog) => {
  try {
    plan(query, catalog);
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

describe("planMetrics: parts and columns", () => {
  it("plans ROAS by month as one part per measure, their values pivoted into the formula", () => {
    const p = plan({ metrics: ["roas", "revenue"], bucket: "month" });
    expect(p.kind).toBe("metrics");
    expect(p.parts.map((x) => [x.from.name, x.date?.name])).toEqual([
      ["orders", "ordered_on"],
      ["products", "launched_on"],
    ]);
    expect(p.bucket).toEqual({
      unit: "month",
      fiscalStartMonth: 1,
      type: "date",
    });
    expect(p.columns.map((c) => [c.name, c.type])).toEqual([
      ["period", "date"],
      ["roas", "number"],
      ["revenue", "number"],
    ]);
    // revenue is one part, read by both names.
    expect(p.select[0]!.expr).toMatchObject({
      kind: "op",
      op: "div",
      args: [
        { kind: "pivot", index: 0 },
        { kind: "pivot", index: 1 },
      ],
    });
    expect(p.select[1]!.expr).toMatchObject({ kind: "pivot", index: 0 });
    expect(p.orderBy).toEqual([{ index: 0, direction: "asc" }]);
    expect(p.defaultOrder).toBe(true);
    expect(p.references).toEqual(
      expect.arrayContaining([
        { tableId: "orders", columnId: "orders.total" },
        { tableId: "orders", columnId: "orders.ordered_on" },
        { tableId: "products", columnId: "products.cost" },
        { tableId: "products", columnId: "products.launched_on" },
      ])
    );
    expect(p.columns[0]!.references).toEqual([
      { tableId: "orders", columnId: "orders.ordered_on" },
      { tableId: "products", columnId: "products.launched_on" },
    ]);
  });

  it("reads a date column through a to-one relation with a left join of the part's own", () => {
    const p = plan({ metrics: ["line_value"], bucket: "week" });
    expect(p.parts[0]!.joins).toEqual([
      expect.objectContaining({
        alias: "t1",
        relation: "product",
        type: "left",
      }),
    ]);
    expect(p.parts[0]!.date).toMatchObject({
      alias: "t1",
      name: "launched_on",
    });
  });

  it("gives one row's plan without a bucket: no period, no order", () => {
    const p = plan({ metrics: ["roas"] });
    expect(p.bucket).toBeUndefined();
    expect(p.columns.map((c) => c.name)).toEqual(["roas"]);
    expect(p.orderBy).toEqual([]);
  });

  it("makes a measure named directly the trivial metric", () => {
    const p = plan({ metrics: ["paid_revenue"], bucket: "quarter" });
    expect(p.parts).toHaveLength(1);
    expect(p.select).toEqual([
      expect.objectContaining({
        output: "paid_revenue",
        expr: expect.objectContaining({ kind: "pivot", index: 0 }),
      }),
    ]);
    // The measure's own where is in its expansion, as in a table query.
    expect(JSON.stringify(p.parts[0]!.expr)).toContain('"case"');
  });

  it("makes a fixed measure a scalar subquery, never a part, named or in a formula", () => {
    const named = plan({ metrics: ["top_balance"] });
    expect(named.parts).toEqual([]);
    expect(named.select[0]!.expr).toMatchObject({ kind: "scalar" });
    const inFormula = plan({ metrics: ["landing"], bucket: "month" });
    expect(inFormula.parts).toHaveLength(1);
    expect(JSON.stringify(inFormula.select[0]!.expr)).toContain('"scalar"');
  });

  it("folds a calendar function of a literal date to a number", () => {
    const p = plan({ metrics: ["landing"] });
    const [, product] = (p.select[0]!.expr as { args: unknown[] }).args as [
      unknown,
      { args: unknown[] },
    ];
    // June 2026 has 22 business days in the default calendar.
    expect(product.args[1]).toEqual({
      kind: "literal",
      value: 22,
      type: "number",
    });
  });

  it("reads periods as timestamps when date and timestamp columns mix", () => {
    const p = plan({ metrics: ["revenue", "revenue_at"], bucket: "month" });
    expect(p.bucket!.type).toBe("timestamp");
    expect(p.columns[0]!.type).toBe("timestamp");
    expect(
      plan({ metrics: ["revenue_at"], bucket: "month" }).bucket!.type
    ).toBe("timestamp");
  });

  it("takes fiscal buckets with the calendar's start month", () => {
    const catalog = metricsCatalog();
    const fiscal = {
      ...catalog,
      calendar: { ...catalog.calendar, fiscalYearStartMonth: 7 },
    };
    expect(
      plan({ metrics: ["revenue"], bucket: "fiscal_year" }, fiscal).bucket
    ).toMatchObject({ unit: "fiscal_year", fiscalStartMonth: 7 });
  });
});

describe("planMetrics: range", () => {
  it("applies relative bounds in the calendar's zone: a date column's local date, a timestamp column's instant", () => {
    const base = metricsCatalog();
    const catalog = {
      ...base,
      calendar: { ...base.calendar, timeZone: "Pacific/Auckland" },
    };
    const gte = { relative: { unit: "month", offset: 0, startOf: true } };
    const lt = { relative: { unit: "day", offset: 1, startOf: true } } as const;
    const p = plan(
      { metrics: ["revenue", "revenue_at"], range: { gte, lt } },
      catalog
    );
    // 12:00 UTC on 15 June is past midnight on 16 June in Auckland.
    expect(p.parts[0]!.range).toEqual({ gte: "2026-06-01", lt: "2026-06-17" });
    expect(p.parts[1]!.range).toEqual({
      gte: resolveRelative(
        { relative: { unit: "month", offset: 0, startOf: true } },
        NOW,
        catalog.calendar
      ).toISOString(),
      lt: resolveRelative(lt, NOW, catalog.calendar).toISOString(),
    });
    expect(p.parts[1]!.range.lt).toBe("2026-06-16T12:00:00.000Z");
  });

  it("reads a date bound as local midnight for a timestamp column, and a timestamp bound as its local date for a date column", () => {
    const p = plan({
      metrics: ["revenue", "revenue_at"],
      range: {
        gte: { date: "2026-03-01" },
        lt: { timestamp: "2026-04-01T03:00:00Z" },
      },
    });
    expect(p.parts[0]!.range).toEqual({ gte: "2026-03-01", lt: "2026-04-01" });
    expect(p.parts[1]!.range).toEqual({
      gte: "2026-03-01T00:00:00.000Z",
      lt: "2026-04-01T03:00:00Z",
    });
  });

  it("refuses a malformed bound at its path, and leaves fixed measures out of the range", () => {
    expect(
      refusal({ metrics: ["revenue"], range: { gte: { date: "2026-02-30" } } })
    ).toMatchObject({ code: "invalid_value", path: ["range", "gte", "date"] });
    expect(
      plan({ metrics: ["top_balance"], range: { gte: { date: "2026-01-01" } } })
        .parts
    ).toEqual([]);
  });
});

describe("planMetrics: refusals", () => {
  it("refuses a bucket or range over a measure with no date column, at its name", () => {
    for (const extra of [
      { bucket: "month" },
      { range: { lt: { date: "2026-01-01" } } },
    ]) {
      expect(
        refusal({ metrics: ["revenue", "undated"], ...extra })
      ).toMatchObject({
        code: "measure_has_no_date",
        path: ["metrics", 1],
        message:
          'Measure "undated" has no date column, which bucket and range need',
      });
    }
    // Without either, it is fine.
    expect(plan({ metrics: ["undated"] }).parts).toHaveLength(1);
  });

  it("treats a date column the caller cannot see exactly as no date column", () => {
    const hidden = metricsCatalog({ hidden: ["orders.ordered_on"] });
    const none = metricsCatalog({ hidden: ["orders.ordered_on"] }, {});
    // The same measure with no date column at all.
    const withNone = {
      ...none,
      measures: none.measures.map((m) =>
        m.name === "paid_revenue" ? { ...m, dateColumn: null } : m
      ),
    };
    expect(
      refusal({ metrics: ["paid_revenue"], bucket: "month" }, hidden)
    ).toEqual(
      refusal({ metrics: ["paid_revenue"], bucket: "month" }, withNone)
    );
  });

  it("refuses a bucket with only fixed measures, and a measure that is not a number", () => {
    expect(
      refusal({ metrics: ["top_balance"], bucket: "month" })
    ).toMatchObject({
      code: "invalid_operator",
      path: ["bucket"],
    });
    expect(refusal({ metrics: ["last_order_on"] })).toMatchObject({
      code: "invalid_operator",
      path: ["metrics", 0],
    });
  });

  it(`refuses more than ${MAX_METRIC_MEASURES} distinct measures as too_complex`, () => {
    const extra = Array.from({ length: 22 }, (_, i) =>
      measure(`m${i}`, { sum: "total" })
    );
    const pairs = Array.from({ length: 11 }, (_, i) =>
      metric(`pair${i}`, {
        add: [{ measure: `m${2 * i}` }, { measure: `m${2 * i + 1}` }],
      })
    );
    const catalog = metricsCatalog({}, { measures: extra, metrics: pairs });
    expect(
      refusal({ metrics: pairs.map((m) => m.name) }, catalog)
    ).toMatchObject({
      code: "too_complex",
      path: ["metrics", 10],
      message: expect.stringContaining('Metric "pair10"'),
    });
    expect(
      plan({ metrics: pairs.slice(0, 10).map((m) => m.name) }, catalog).parts
    ).toHaveLength(20);
  });

  it("orders by period or a requested name, and refuses anything else", () => {
    const p = plan({
      metrics: ["roas", "revenue"],
      bucket: "month",
      orderBy: [{ revenue: "desc" }, { period: "asc" }],
      limit: 3,
      offset: 1,
    });
    expect(p.orderBy).toEqual([
      { index: 2, direction: "desc" },
      { index: 0, direction: "asc" },
    ]);
    expect([p.limit, p.offset, p.defaultOrder]).toEqual([3, 1, false]);
    expect(
      refusal({ metrics: ["roas"], orderBy: [{ period: "asc" }] })
    ).toMatchObject({ code: "invalid_order", path: ["orderBy", 0, "period"] });
    expect(
      refusal({ metrics: ["roas"], bucket: "day", orderBy: [{ total: "asc" }] })
    ).toMatchObject({ code: "invalid_order", path: ["orderBy", 0, "total"] });
  });
});

describe("planMetrics: grants (Review Focus 3)", () => {
  /** products.cost hidden: spend, secret_cost, roas and secret_roas are invisible. */
  const hidden = metricsCatalog({ hidden: ["products.cost"] });
  const absent = (names: string[]) => {
    const catalog = metricsCatalog({ hidden: ["products.cost"] });
    return {
      ...catalog,
      metrics: catalog.metrics.filter((m) => !names.includes(m.name)),
    };
  };

  it("hides a metric using a measure the caller cannot see", () => {
    expect(hidden.metrics.map((m) => m.name).sort()).toEqual([
      "landing",
      "paid_share",
    ]);
  });

  it("refuses a metric over an invisible measure exactly as a nonexistent one", () => {
    const seen = refusal({ metrics: ["revenue", "secret_roas"] }, hidden);
    expect(seen).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["metrics", 1],
      message: 'Metric "secret_roas" was not found or is not accessible',
    });
    expect(seen).toEqual(
      refusal({ metrics: ["revenue", "secret_roas"] }, absent(["secret_roas"]))
    );
  });

  it("refuses an invisible measure named directly exactly as a nonexistent name", () => {
    const catalog = metricsCatalog({ hidden: ["products.cost"] });
    const withoutRow = metricsCatalog({ hidden: ["products.cost"] });
    expect(refusal({ metrics: ["secret_cost"] }, catalog)).toEqual(
      refusal(
        { metrics: ["secret_cost"] },
        {
          ...withoutRow,
          measures: withoutRow.measures.filter((m) => m.name !== "secret_cost"),
        }
      )
    );
    expect(
      refusal({ metrics: ["secret_cost"] }, catalog).suggestions
    ).not.toContain("spend");
  });
});

describe("planMetrics: fingerprints", () => {
  const rows = { limit: 101, offset: 0 };
  const fingerprint = (catalog: VisibleCatalog, query: object) =>
    fingerprintOf("src", plan(query, catalog), rows);

  it("changes when a measure or a metric it uses changes", () => {
    const query = { metrics: ["roas"], bucket: "month" };
    const before = fingerprint(metricsCatalog(), query);
    expect(fingerprint(metricsCatalog(), query)).toBe(before);
    const measureChanged = metricsCatalog();
    measureChanged.measures = measureChanged.measures.map((m) =>
      m.name === "spend" ? { ...m, formula: { sum: { mul: ["cost", 2] } } } : m
    );
    expect(fingerprint(measureChanged, query)).not.toBe(before);
    const dateChanged = metricsCatalog();
    dateChanged.measures = dateChanged.measures.map((m) =>
      m.name === "revenue" ? { ...m, dateColumn: "created_at" } : m
    );
    expect(fingerprint(dateChanged, query)).not.toBe(before);
    const metricChanged = metricsCatalog();
    metricChanged.metrics = metricChanged.metrics.map((m) =>
      m.name === "roas"
        ? {
            ...m,
            formula: {
              div: [{ measure: "paid_revenue" }, { measure: "spend" }],
            },
          }
        : m
    );
    expect(fingerprint(metricChanged, query)).not.toBe(before);
  });
});

describe("metricQuerySchema", () => {
  const issues = (query: object) => {
    const r = sqlLanguage.schema.safeParse({ source: "shop", ...query });
    return r.success ? [] : r.error.issues.map((i) => i.path);
  };

  it("is chosen by the metrics key, and keeps every issue's exact path", () => {
    expect(issues({ metrics: ["a"], bucket: "month" })).toEqual([]);
    expect(issues({ metrics: ["a", "a"] })).toEqual([["metrics", 1]]);
    expect(issues({ metrics: ["A"] })).toEqual([["metrics", 0]]);
    expect(issues({ metrics: [] })).toEqual([["metrics"]]);
    expect(issues({ metrics: ["a"], range: { gte: { date: 5 } } })).toEqual([
      ["range", "gte", "date"],
    ]);
    expect(issues({ metrics: ["a"], range: { gte: { day: "x" } } })).toEqual([
      ["range", "gte"],
    ]);
    expect(issues({ metrics: ["a"], range: {} })).toEqual([["range"]]);
    expect(issues({ metrics: ["a"], bucket: "hour" })).toEqual([["bucket"]]);
    // A table query's keys are not a metric query's.
    expect(issues({ metrics: ["a"], from: "orders" })).toEqual([[]]);
    // Without metrics it is a table query, as before.
    expect(issues({ from: "orders", select: [{ nope: 1 }] })).toEqual([
      ["select", 0],
    ]);
    expect(
      metricQuerySchema.safeParse({
        source: "s",
        metrics: Array.from({ length: 21 }, (_, i) => `m${i}`),
      }).success
    ).toBe(false);
    expect(
      sqlQuerySchema.safeParse({ source: "s", metrics: ["a"] }).success
    ).toBe(false);
  });
});

describe("metric formulas", () => {
  it("take numbers, measures, arithmetic and calendar constants only", () => {
    expect(
      metricFormulaProblem({
        round: [
          {
            div: [
              { add: [{ measure: "a" }, 1] },
              {
                businessDays: [
                  { date: "2026-01-01" },
                  { relative: { unit: "day", offset: 0 } },
                ],
              },
            ],
          },
          2,
        ],
      })
    ).toBeUndefined();
    const refused: [unknown, (string | number)[]][] = [
      ["total", []],
      [{ add: ["total", { measure: "a" }] }, ["add", 0]],
      [{ sum: "total" }, ["sum"]],
      [{ case: { when: [{ if: { a: { eq: 1 } }, then: 1 }] } }, ["case"]],
      [{ concat: [{ measure: "a" }, { value: "x" }] }, ["concat"]],
      [{ abs: { value: "x" } }, ["abs"]],
      [{ businessDaysInMonth: "ordered_on" }, ["businessDaysInMonth"]],
      [
        { dateDiff: ["day", { date: "2026-01-01" }, { date: "2026-01-02" }] },
        ["dateDiff"],
      ],
    ];
    for (const [formula, path] of refused) {
      expect(
        metricFormulaProblem(formula),
        JSON.stringify(formula)
      ).toMatchObject({
        path,
      });
    }
    expect(metricFormulaProblem({ add: [1, 2] })).toMatchObject({
      message: "A metric's formula uses at least one measure",
    });
    // Not an expression of the language at all.
    expect(metricFormulaProblem({ add: [1] })).toBeDefined();
  });

  it("names their measures once each", () => {
    expect(
      metricFormulaMeasures({
        add: [{ measure: "a" }, { mul: [{ measure: "b" }, { measure: "a" }] }],
      })
    ).toEqual(["a", "b"]);
  });

  it("hide a metric whose stored formula is not a metric's", () => {
    const catalog = metricsCatalog();
    const rows: MetricRow[] = [
      metric("ok", { measure: "revenue" }),
      metric("reads_a_column", { add: ["total", { measure: "revenue" }] }),
      metric("unknown_measure", { measure: "nope" }),
      { ...metric("other_source", { measure: "revenue" }), sourceId: "x" },
    ];
    expect(visibleMetrics(catalog, rows).map((m) => m.name)).toEqual(["ok"]);
    expect(MEASURES.length).toBeGreaterThan(0);
  });
});
