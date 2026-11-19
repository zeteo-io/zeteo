// @module-tag unit
// @module-tag platform
import { shopCatalog, type ShopOptions } from "../support/pure/shopCatalog.js";
import { sqlQuerySchema } from "../../adapters/sql/language.js";
import { visibleMeasures } from "../../measures/visible.js";
import { planSql } from "../../adapters/sql/plan.js";
import { QueryError } from "../../engine/errors.js";
import { describe, expect, it } from "vitest";
import type {
  MeasureRow,
  VisibleCatalog,
} from "../../grants/visibleCatalog.js";

// The grant rule: a measure that reads anything the caller may not see does
// not exist for them. It is absent from the catalogue, and using it fails
// exactly as using a measure that was never defined.

const PAID = { status: { eq: "paid" } };
const THIS_YEAR = { relative: { unit: "year", offset: 0, startOf: true } };

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
  measure("paid_share", {
    div: [{ measure: "paid_revenue" }, { measure: "total_revenue" }],
  }),
  measure("region_rev", { sum: "total" }, { "customer.region": { eq: "EU" } }),
  measure(
    "pro_rev",
    { sum: "total" },
    { "customer.account.plan": { eq: "pro" } }
  ),
  measure("noted", { add: [{ sum: "total" }, { count: "notes" }] }),
  measure("customers_n", { count: "*" }, null, "customers"),
];

const names = (options: ShopOptions, rows = MEASURES) =>
  shopCatalog({ ...options, measures: rows })
    .measures.map((m) => m.name)
    .sort();

/** Every field of the error a query using `name` from `from` gets. */
const errorOf = (
  name: string,
  catalog: VisibleCatalog,
  from = "orders"
): Record<string, unknown> => {
  try {
    planSql(
      sqlQuerySchema.parse({
        source: "shop",
        from,
        select: [{ calc: { mul: [{ measure: name }, 2] }, as: "x" }],
      }),
      catalog
    );
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
      headers: err.headers,
    };
  }
  throw new Error("the query was planned");
};

describe("visibleMeasures: the grant rule", () => {
  it("shows every measure to a caller who sees everything it reads", () => {
    expect(names({})).toEqual(MEASURES.map((m) => m.name).sort());
  });

  it("hides a measure reading an ungranted column, and every measure using it", () => {
    expect(names({ hidden: ["orders.status"] })).toEqual([
      "customers_n",
      "noted",
      "pro_rev",
      "region_rev",
      "total_revenue",
    ]);
  });

  it("hides a measure whose where reads an ungranted column of a relation", () => {
    expect(names({ hidden: ["customers.region"] })).not.toContain("region_rev");
  });

  it("hides a measure whose relation is not visible, its key ungranted", () => {
    const visible = names({ hidden: ["customers.account_id"] });
    expect(visible).not.toContain("pro_rev");
    expect(visible).toContain("region_rev");
  });

  it("hides every measure of a table the caller cannot see", () => {
    expect(names({ hidden: ["customers"] })).toEqual([
      "noted",
      "paid_revenue",
      "paid_share",
      "paid_ytd",
      "total_revenue",
    ]);
  });

  it("keeps a measure reading a missing but granted column, so using it says missing_in_source", () => {
    const catalog = shopCatalog({
      missing: ["orders.status"],
      measures: MEASURES,
    });
    expect(catalog.measures.map((m) => m.name)).toContain("paid_ytd");
    expect(errorOf("paid_ytd", catalog)).toMatchObject({
      code: "missing_in_source",
      message: 'Measure "paid_ytd": Column "status" is missing from the source',
    });
  });

  it("hides a measure that reads a missing column before an ungranted one", () => {
    // Deciding with the missing flag would stop at "total" and never reach "notes".
    expect(
      names({ missing: ["orders.total"], hidden: ["orders.notes"] })
    ).not.toContain("noted");
  });

  it("hides a measure using one that does not exist, or one of another table", () => {
    const rows = [
      measure("orphan", { measure: "gone" }),
      measure("crossed", { measure: "customers_n" }),
      ...MEASURES,
    ];
    const visible = names({}, rows);
    expect(visible).not.toContain("orphan");
    expect(visible).not.toContain("crossed");
  });

  it("hides cycles and structurally broken measures without hanging", () => {
    const rows = [
      measure("a", { measure: "b" }),
      measure("b", { measure: "a" }),
      measure("bare", "total"),
      measure("lines_n", { count: "lines.sku" }),
      ...MEASURES,
    ];
    expect(names({}, rows)).toEqual(MEASURES.map((m) => m.name).sort());
  });

  it("ignores rows of another source", () => {
    expect(
      names({}, [
        { ...measure("elsewhere", { sum: "total" }), sourceId: "other" },
      ])
    ).toEqual([]);
  });

  it("plans each of 200 measures once, quickly", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      measure(
        `m${i}`,
        i % 8 === 7
          ? { sum: "total" }
          : { add: [{ measure: `m${i + 1}` }, { sum: "total" }] },
        PAID
      )
    );
    const catalog = shopCatalog();
    const started = performance.now();
    expect(visibleMeasures(catalog, rows)).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("planSql: a hidden measure fails as one that does not exist", () => {
  const HIDDEN: ShopOptions = { hidden: ["orders.status"] };
  const ABSENT = MEASURES.filter(
    (m) => !["paid_revenue", "paid_ytd", "paid_share"].includes(m.name)
  );

  it("answers a hidden measure with the very error of a measure never defined", () => {
    for (const name of ["paid_ytd", "paid_revenue", "paid_share"]) {
      expect(
        errorOf(name, shopCatalog({ ...HIDDEN, measures: MEASURES }))
      ).toEqual(errorOf(name, shopCatalog({ ...HIDDEN, measures: ABSENT })));
    }
  });

  it("answers paid_ytd as it answers nonexistent_measure, name for name", () => {
    const catalog = shopCatalog({ ...HIDDEN, measures: MEASURES });
    const hidden = errorOf("paid_ytd", catalog);
    const nonexistent = errorOf("nonexistent_measure", catalog);
    expect(hidden).toEqual({
      ...nonexistent,
      message: (nonexistent.message as string).replace(
        "nonexistent_measure",
        "paid_ytd"
      ),
    });
    expect(hidden).toMatchObject({
      code: "not_found_or_not_accessible",
      path: ["select", 0, "calc", "mul", 0, "measure"],
      suggestions: [],
    });
  });

  it("never suggests a hidden measure", () => {
    const query = (options: ShopOptions) =>
      errorOf("paid_revenu", shopCatalog({ ...options, measures: MEASURES }))
        .suggestions;
    expect(query({})).toEqual(["paid_revenue"]);
    expect(query(HIDDEN)).toEqual([]);
  });

  it("answers a hidden measure from another table as one never defined", () => {
    const hiddenTable: ShopOptions = { hidden: ["orders"] };
    expect(
      errorOf(
        "total_revenue",
        shopCatalog({ ...hiddenTable, measures: MEASURES }),
        "customers"
      )
    ).toEqual(
      errorOf(
        "total_revenue",
        shopCatalog({ ...hiddenTable, measures: [] }),
        "customers"
      )
    );
  });

  it("refuses a hidden measure as not found before any check that would tell it apart", () => {
    // A to-many join refuses a usable measure; a hidden one is still not found.
    const plan = (rows: MeasureRow[]) => {
      try {
        planSql(
          sqlQuerySchema.parse({
            source: "shop",
            from: "orders",
            join: ["lines"],
            select: [{ measure: "paid_revenue" }],
          }),
          shopCatalog({ ...HIDDEN, measures: rows })
        );
      } catch (err) {
        if (err instanceof QueryError) return [err.code, err.message, err.path];
        throw err;
      }
      throw new Error("the query was planned");
    };
    expect(plan(MEASURES)).toEqual(plan(ABSENT));
    expect(plan(MEASURES)[0]).toBe("not_found_or_not_accessible");
  });
});

describe("visibleMeasures: unexpected failures", () => {
  it("hides a malformed stored formula and reports it", () => {
    const reported: Array<[unknown, string]> = [];
    const rows = [
      measure("malformed", { sum: { bogus: "total" } }),
      measure("total_revenue", { sum: "total" }),
    ];
    const visible = visibleMeasures(shopCatalog(), rows, (err, id) =>
      reported.push([err, id])
    );
    expect(visible.map((m) => m.name)).toEqual(["total_revenue"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]![1]).toBe("m-malformed");
    expect(reported[0]![0]).toBeInstanceOf(Error);
  });

  it("does not report a measure the planner refuses", () => {
    const reported: unknown[] = [];
    visibleMeasures(
      shopCatalog({ hidden: ["orders.status"] }),
      [
        ...MEASURES,
        measure("a", { measure: "b" }),
        measure("b", { measure: "a" }),
      ],
      (err) => reported.push(err)
    );
    expect(reported).toEqual([]);
  });
});
