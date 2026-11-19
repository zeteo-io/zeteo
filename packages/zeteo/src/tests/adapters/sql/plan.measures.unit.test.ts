// @module-tag unit
// @module-tag platform
import type { ResolvedJoin } from "../../../adapters/sql/types.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import type {
  MeasureRow,
  VisibleCatalog,
} from "../../../grants/visibleCatalog.js";
import {
  MAX_EXPANDED_NODES,
  MAX_MEASURE_NESTING,
  MeasureError,
  expandMeasure,
} from "../../../adapters/sql/measures.js";
import {
  shopCatalog,
  type ShopOptions,
} from "../../support/pure/shopCatalog.js";

const NOW = new Date("2026-06-15T12:00:00Z");
const THIS_YEAR = { relative: { unit: "year", offset: 0, startOf: true } };
const PAID = { status: { eq: "paid" } };

const measure = (
  name: string,
  formula: unknown,
  where: unknown = null,
  tableId = "orders"
): MeasureRow =>
  ({
    id: `m-${name}`,
    sourceId: "src",
    tableId,
    name,
    description: `The ${name}`,
    formula,
    where,
  }) as MeasureRow;

const MEASURES: MeasureRow[] = [
  measure("total_revenue", { sum: "total" }),
  measure("paid_revenue", { measure: "total_revenue" }, PAID),
  measure(
    "paid_ytd",
    { measure: "paid_revenue" },
    { created_at: { gte: THIS_YEAR } }
  ),
  measure("region_rev", { sum: "total" }, { "customer.region": { eq: "EU" } }),
  measure(
    "pro_rev",
    { sum: "total" },
    { "customer.account.plan": { eq: "pro" } }
  ),
  measure("orders_n", { count: "*" }),
  measure("paid_orders", { measure: "orders_n" }, PAID),
  measure("named_orders", { count: "notes" }, PAID),
];

const catalogWith = (
  extra: MeasureRow[] = [],
  options: ShopOptions = {}
): VisibleCatalog =>
  shopCatalog({ ...options, measures: [...MEASURES, ...extra] });

const plan = (query: object, catalog: VisibleCatalog = catalogWith()) =>
  planSql(
    sqlQuerySchema.parse({ source: "shop", from: "orders", ...query }),
    catalog,
    { now: NOW }
  );

const refusal = (query: object, catalog?: VisibleCatalog) => {
  try {
    plan(query, catalog);
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return {
      code: err.code,
      path: err.path,
      message: err.message,
      suggestions: err.suggestions,
    };
  }
  throw new Error("the query was planned");
};

const byName = (rows: MeasureRow[]) =>
  new Map(rows.map((r) => [r.name, { ...r }]));

/** A chain m0 → m1 → … → m{n-1}, the last a sum. */
const chain = (n: number): MeasureRow[] =>
  Array.from({ length: n }, (_, i) =>
    measure(`m${i}`, i === n - 1 ? { sum: "total" } : { measure: `m${i + 1}` })
  );

describe("expandMeasure", () => {
  it("pushes every where into the aggregate, the innermost first", () => {
    const { expr, relationPaths, uses } = expandMeasure(
      "paid_ytd",
      "orders",
      byName(MEASURES)
    );
    expect(expr).toEqual({
      sum: {
        case: {
          when: [
            {
              if: { and: [PAID, { created_at: { gte: THIS_YEAR } }] },
              then: "total",
            },
          ],
        },
      },
    });
    expect(relationPaths).toEqual([]);
    expect(uses.sort()).toEqual(["paid_revenue", "total_revenue"]);
  });

  it("counts a case of 1 for count(*) and of the path for count(path)", () => {
    expect(
      expandMeasure("paid_orders", "orders", byName(MEASURES)).expr
    ).toEqual({
      count: { case: { when: [{ if: PAID, then: 1 }] } },
    });
    expect(
      expandMeasure("named_orders", "orders", byName(MEASURES)).expr
    ).toEqual({
      count: { case: { when: [{ if: PAID, then: "notes" }] } },
    });
  });

  it("lists the relation paths it reads, parents before children", () => {
    expect(
      expandMeasure("pro_rev", "orders", byName(MEASURES)).relationPaths
    ).toEqual(["customer", "customer.account"]);
  });

  it("leaves a measure without a where as it is", () => {
    expect(
      expandMeasure("total_revenue", "orders", byName(MEASURES)).expr
    ).toEqual({
      sum: "total",
    });
  });

  const expansionError = (name: string, rows: MeasureRow[]) => {
    try {
      expandMeasure(name, "orders", byName(rows));
    } catch (err) {
      if (err instanceof MeasureError) return err.code;
      throw err;
    }
    throw new Error("the measure expanded");
  };

  it("refuses a cycle with measure_cycle", () => {
    const rows = [
      measure("a", { measure: "b" }),
      measure("b", { add: [{ measure: "a" }, { sum: "total" }] }),
    ];
    expect(expansionError("a", rows)).toBe("measure_cycle");
    expect(expansionError("b", [measure("b", { measure: "b" })])).toBe(
      "measure_cycle"
    );
  });

  it(`takes ${MAX_MEASURE_NESTING} levels of measures using measures and refuses ${MAX_MEASURE_NESTING + 1}`, () => {
    const ok = chain(MAX_MEASURE_NESTING + 1);
    expect(expandMeasure("m0", "orders", byName(ok)).expr).toEqual({
      sum: "total",
    });
    expect(expansionError("m0", chain(MAX_MEASURE_NESTING + 2))).toBe(
      "measure_too_deep"
    );
  });

  it("refuses a formula reading a column outside an aggregate with measure_not_aggregate", () => {
    for (const formula of [
      "total",
      { add: [{ sum: "total" }, "total"] },
      { case: { when: [{ if: PAID, then: { sum: "total" } }] } },
      7,
    ]) {
      expect(expansionError("x", [measure("x", formula)])).toBe(
        "measure_not_aggregate"
      );
    }
  });

  it("refuses a measure inside an aggregate", () => {
    expect(
      expansionError("x", [
        ...MEASURES,
        measure("x", { sum: { measure: "total_revenue" } }),
      ])
    ).toBe("invalid_operator");
  });

  it("refuses a measure of another table as not found", () => {
    expect(
      expansionError("x", [
        measure("x", { measure: "y" }),
        measure("y", { sum: "total" }, null, "customers"),
      ])
    ).toBe("not_found_or_not_accessible");
  });

  it(`stops at ${MAX_EXPANDED_NODES} operations, however much the measures would expand to`, () => {
    // Each level doubles: 2^8 copies of the sum would be far past the limit.
    const rows = Array.from({ length: 9 }, (_, i) =>
      measure(
        `d${i}`,
        i === 8
          ? { sum: "total" }
          : { add: [{ measure: `d${i + 1}` }, { measure: `d${i + 1}` }] }
      )
    );
    expect(expansionError("d0", rows)).toBe("too_complex");
  });
});

describe("planSql: measures", () => {
  it("resolves a measure to the expression its formula and wheres stand for", () => {
    const measured = plan({ select: [{ measure: "paid_ytd" }] });
    const written = plan({
      select: [
        {
          sum: {
            case: {
              when: [
                {
                  if: { and: [PAID, { created_at: { gte: THIS_YEAR } }] },
                  then: "total",
                },
              ],
            },
          },
          as: "paid_ytd",
        },
      ],
    });
    expect(measured.select).toEqual(written.select);
    expect(measured.columns).toEqual(written.columns);
    const expr =
      measured.select[0]!.kind === "calc" && measured.select[0]!.expr;
    expect(expr).toMatchObject({
      kind: "aggregate",
      fn: "sum",
      arg: {
        kind: "case",
        branches: [
          {
            when: {
              kind: "and",
              filters: [
                { kind: "compare", op: "eq", value: "paid" },
                {
                  kind: "compare",
                  op: "gte",
                  value: "2026-01-01T00:00:00.000Z",
                },
              ],
            },
            then: { kind: "column", column: { alias: "t0", name: "total" } },
          },
        ],
      },
    });
    expect(measured.select[0]).toMatchObject({ kind: "calc", level: "group" });
  });

  it("names the output by the measure, or by its as", () => {
    expect(
      plan({ select: [{ measure: "total_revenue" }] }).columns[0]!.name
    ).toBe("total_revenue");
    expect(
      plan({ select: [{ measure: "total_revenue", as: "rev" }] }).columns[0]!
        .name
    ).toBe("rev");
  });

  it("adds the joins a measure needs as left joins after the query's own", () => {
    const { joins } = plan({ select: [{ measure: "region_rev" }] });
    expect(joins).toEqual<ResolvedJoin[]>([
      {
        alias: "t1",
        relation: "customer",
        table: { schemaName: "shop", name: "customers" },
        type: "left",
        on: [["t0", "customer_id", "id"]],
      },
    ]);
  });

  it("reuses a join the query made, keeping its type", () => {
    const { joins, select } = plan({
      join: ["customer"],
      select: ["customer.region", { measure: "region_rev" }],
      groupBy: ["customer.region"],
    });
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ alias: "t1", type: "inner" });
    expect(select[1]).toMatchObject({ kind: "calc", level: "group" });
  });

  it("adds a two-step path parent first, with the next aliases", () => {
    const { joins } = plan({
      join: [{ relation: "customer", type: "left" }],
      select: [{ measure: "pro_rev" }],
    });
    expect(joins.map((j) => [j.alias, j.relation, j.type])).toEqual([
      ["t1", "customer", "left"],
      ["t2", "customer.account", "left"],
    ]);
  });

  it("refuses a measure's join past the source's max_joins with too_many_joins at the measure", () => {
    // A second to-one relation to customers, so the query's own join is not the measure's.
    const catalog = catalogWith([], { maxJoins: 1 });
    const buyer = { ...catalog.relations.find((r) => r.name === "customer")! };
    const withBuyer = {
      ...catalog,
      relations: [
        ...catalog.relations,
        { ...buyer, id: "orders.buyer", name: "buyer" },
      ],
    };
    expect(
      plan({ select: [{ measure: "region_rev" }] }, withBuyer).joins
    ).toHaveLength(1);
    expect(
      refusal(
        { join: ["buyer"], select: [{ measure: "region_rev" }] },
        withBuyer
      )
    ).toEqual({
      code: "too_many_joins",
      path: ["select", 0, "measure"],
      message: 'Measure "region_rev": This source allows at most 1 join',
      suggestions: [],
    });
  });

  it("hides a measure that could never fit the source's max_joins", () => {
    expect(
      catalogWith([], { maxJoins: 1 }).measures.map((m) => m.name)
    ).not.toContain("pro_rev");
  });

  it("refuses a measure in a query that joins a to-many relation with measure_needs_single_rows", () => {
    expect(
      refusal({ join: ["lines"], select: [{ measure: "total_revenue" }] })
    ).toEqual({
      code: "measure_needs_single_rows",
      path: ["select", 0, "measure"],
      message:
        "total_revenue counts each orders row once; this query's join of lines repeats rows. Query from orders without it.",
      suggestions: [],
    });
  });

  it("refuses a measure of another table as not found, suggesting only the from table's measures", () => {
    expect(
      refusal({ from: "customers", select: [{ measure: "total_revenue" }] })
    ).toEqual({
      code: "not_found_or_not_accessible",
      path: ["select", 0, "measure"],
      message: 'Measure "total_revenue" was not found or is not accessible',
      suggestions: [],
    });
    expect(
      refusal({ select: [{ measure: "paid_revenu" }] }).suggestions
    ).toEqual(["paid_revenue"]);
  });

  it("plans a measure inside a calc as group-level", () => {
    const { select } = plan({
      select: [
        {
          calc: { div: [{ measure: "paid_revenue" }, { count: "*" }] },
          as: "x",
        },
      ],
    });
    expect(select[0]).toMatchObject({
      kind: "calc",
      level: "group",
      output: "x",
      expr: { kind: "op", op: "div" },
    });
  });

  it("refuses a measure beside a bare column in one calc", () => {
    expect(
      refusal({
        select: [
          { calc: { add: [{ measure: "total_revenue" }, "total"] }, as: "x" },
        ],
      })
    ).toMatchObject({ code: "invalid_grouping" });
  });

  it("reports an error inside a measure at the measure's path, naming it", () => {
    // A missing column is still granted: the measure stays usable, and fails.
    const catalog = catalogWith([], { missing: ["orders.status"] });
    expect(catalog.measures.map((m) => m.name)).toContain("paid_ytd");
    expect(
      refusal(
        { select: [{ calc: { mul: [{ measure: "paid_ytd" }, 2] }, as: "x" }] },
        catalog
      )
    ).toEqual({
      code: "missing_in_source",
      path: ["select", 0, "calc", "mul", 0, "measure"],
      message: 'Measure "paid_ytd": Column "status" is missing from the source',
      suggestions: [],
    });
  });

  it("reports a structural error of a stored measure at the measure's path", () => {
    expect(
      refusal(
        { select: [{ measure: "bad" }] },
        // Planned directly: a structurally broken row is not in the catalogue.
        { ...catalogWith(), measures: [measure("bad", "total")] }
      )
    ).toMatchObject({
      code: "measure_not_aggregate",
      path: ["select", 0, "measure"],
      message: expect.stringMatching(/^Measure "bad": /),
    });
  });

  it(`refuses a query whose measures expand past ${MAX_EXPANDED_NODES} operations with too_complex`, () => {
    // 21 operations each, so the 24th pushes the query past the limit; the
    // query's own count (one per measure) stays far under its own.
    const big = measure("big", {
      add: Array.from({ length: 10 }, () => ({ abs: { sum: "total" } })),
    });
    const catalog = catalogWith([big]);
    expect(
      refusal(
        {
          select: Array.from({ length: 30 }, (_, i) => ({
            measure: "big",
            as: `b${i}`,
          })),
        },
        catalog
      )
    ).toMatchObject({ code: "too_complex", path: ["select", 23, "measure"] });
  });

  it("orders and filters by a measure's output name like any aggregate", () => {
    const { having, orderBy } = plan({
      select: ["status", { measure: "total_revenue" }],
      groupBy: ["status"],
      having: { total_revenue: { gt: 10 } },
      orderBy: [{ total_revenue: "desc" }],
    });
    expect(having).toMatchObject({ kind: "compare", subject: { index: 1 } });
    expect(orderBy).toEqual([
      { target: { kind: "output", index: 1 }, direction: "desc" },
    ]);
  });
});

describe("sqlQuerySchema: measures", () => {
  const parse = (select: unknown[]) =>
    sqlQuerySchema.safeParse({ source: "shop", from: "orders", select });

  it("takes a measure as a select item and as an expression", () => {
    expect(parse([{ measure: "total_revenue" }]).success).toBe(true);
    expect(parse([{ measure: "total_revenue", as: "rev" }]).success).toBe(true);
    expect(
      parse([{ calc: { div: [{ measure: "a" }, { measure: "b" }] }, as: "x" }])
        .success
    ).toBe(true);
  });

  it("refuses a bad name and extra keys", () => {
    // A measure inside an aggregate parses: only a fixed one plans there.
    expect(parse([{ sum: { measure: "a" }, as: "x" }]).success).toBe(true);
    expect(parse([{ measure: "Total" }]).success).toBe(false);
    expect(parse([{ measure: "a", calc: 1 }]).success).toBe(false);
    expect(
      parse([{ calc: { add: [{ measure: "a", as: "b" }, 1] }, as: "x" }])
        .success
    ).toBe(false);
  });
});

describe("planSql: a measure's joins stay the measure's", () => {
  // The same query with the measure replaced by a plain sum of the same name.
  const without = (query: { select: unknown[] }) => ({
    ...query,
    select: query.select.map((item) =>
      typeof item === "object" && item !== null && "measure" in item
        ? { sum: "total", as: (item as { measure: string }).measure }
        : item
    ),
  });

  it.each([
    [
      "a select item after the measure",
      { select: [{ measure: "region_rev" }, "customer.region"] },
    ],
    [
      "a select item before the measure",
      { select: ["customer.region", { measure: "region_rev" }] },
    ],
    [
      "a where",
      {
        select: [{ measure: "region_rev" }],
        where: { "customer.region": { eq: "EU" } },
      },
    ],
    [
      "a calc",
      {
        select: [
          { measure: "region_rev" },
          { calc: { lower: "customer.region" }, as: "r" },
        ],
      },
    ],
  ])(
    "refuses %s reading a relation only the measure joined, as without the measure",
    (_, query) => {
      const refused = refusal(query);
      expect(refused).toMatchObject({ code: "not_found_or_not_accessible" });
      expect(refused).toEqual(refusal(without(query)));
    }
  );

  it("shares one added join between measures reading the same relation", () => {
    const { joins } = plan(
      {
        select: [
          { measure: "region_rev" },
          { measure: "us_orders" },
          { measure: "pro_rev" },
        ],
      },
      catalogWith([
        measure(
          "us_orders",
          { count: "*" },
          { "customer.region": { eq: "US" } }
        ),
      ])
    );
    expect(joins.map((j) => [j.alias, j.relation, j.type])).toEqual([
      ["t1", "customer", "left"],
      ["t2", "customer.account", "left"],
    ]);
  });

  it("lets a query join a relation a measure joined before it, as its own", () => {
    const { joins } = plan({
      join: ["customer"],
      select: ["customer.region", { measure: "region_rev" }],
      groupBy: ["customer.region"],
    });
    expect(joins.map((j) => [j.alias, j.type])).toEqual([["t1", "inner"]]);
  });
});
