// @module-tag unit
// @module-tag platform
import { sqlLanguage, sqlQuerySchema } from "../../../adapters/sql/language.js";
import { describe, expect, it } from "vitest";

const SPEC_EXAMPLE = {
  source: "sales-db",
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

const base = { source: "shop", from: "orders", select: ["id"] };

/** A filter nested `depth` levels deep: `not` around `not` … around a comparison. */
const nested = (depth: number): unknown =>
  depth === 1 ? { status: { eq: "paid" } } : { not: nested(depth - 1) };

const issuesOf = (value: unknown) => {
  const result = sqlQuerySchema.safeParse(value);
  return result.success ? [] : result.error.issues;
};

describe("sqlQuerySchema", () => {
  it("parses the spec's example unchanged", () => {
    expect(sqlQuerySchema.parse(SPEC_EXAMPLE)).toEqual(SPEC_EXAMPLE);
  });

  it("parses every select item, operator and logical form", () => {
    const query = {
      ...base,
      distinct: true,
      select: [
        "id",
        "customer.account.name",
        { count: "*" },
        { count: "id", as: "n" },
        { countDistinct: "customer_id" },
        { avg: "total" },
        { min: "created_at" },
        { max: "created_at" },
        ...(["day", "week", "month", "quarter", "year"] as const).map(
          (bucket) => ({ bucket, column: "created_at", as: `b_${bucket}` })
        ),
      ],
      where: {
        and: [
          { status: { eq: "paid" }, total: { gte: "10.50" } },
          { or: [{ vip: { ne: true } }, { notes: { isNull: true } }] },
          { not: { "customer.name": { contains: "%_" } } },
          { sku: { startsWith: "A" } },
          { total: { between: [1, 2] } },
          { status: { notIn: ["x"] } },
          { total: { lt: 1 }, id: { lte: 2 }, customer_id: { gt: 0 } },
        ],
      },
    };
    expect(sqlQuerySchema.parse(query)).toEqual(query);
  });

  it("requires source, from and select", () => {
    for (const key of ["source", "from", "select"] as const) {
      const { [key]: _, ...rest } = base;
      expect(issuesOf(rest).map((i) => i.path)).toContainEqual([key]);
    }
  });

  it.each([
    ["51 select items", { select: Array(51).fill("id") }, 50],
    ["no select items", { select: [] }, 1],
    ["9 joins", { join: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }, 8],
    ["a filter 6 deep", { where: nested(6) }, 5],
    [
      "1,001 values in `in`",
      { where: { id: { in: Array(1001).fill(1) } } },
      1000,
    ],
    [
      "1,001 values in `notIn`",
      { where: { id: { notIn: Array(1001).fill(1) } } },
      1000,
    ],
    ["an empty `in`", { where: { id: { in: [] } } }, 1],
    ["offset 1,000,001", { offset: 1_000_001 }, 1_000_000],
    ["offset -1", { offset: -1 }, 0],
    ["limit 0", { limit: 0 }, 1],
    ["a fractional limit", { limit: 1.5 }, 1],
    ["a path segment of 129 characters", { select: ["x".repeat(129)] }, 128],
    [
      "an alias of 64 characters",
      { select: [{ count: "*", as: `a${"b".repeat(63)}` }] },
      63,
    ],
  ])("refuses %s (bound %s)", (_, over, _bound) => {
    expect(issuesOf({ ...base, ...over })).not.toEqual([]);
  });

  it.each([
    ["50 select items", { select: Array(50).fill("id") }],
    ["8 joins", { join: ["a", "b", "c", "d", "e", "f", "g", "h"] }],
    ["a filter 5 deep", { where: nested(5) }],
    ["1,000 values in `in`", { where: { id: { in: Array(1000).fill(1) } } }],
    ["offset 1,000,000", { offset: 1_000_000 }],
    ["limit 1", { limit: 1 }],
    ["a path segment of 128 characters", { select: ["x".repeat(128)] }],
    [
      "an alias of 63 characters",
      { select: [{ count: "*", as: `a${"b".repeat(62)}` }] },
    ],
  ])("accepts %s", (_, over) => {
    expect(issuesOf({ ...base, ...over })).toEqual([]);
  });

  // Depth counts filter objects: a comparison directly under `where` is 1,
  // each `and`, `or` or `not` adds one around what it holds.
  it("counts a comparison directly under where as depth 1 and each logical level as one more", () => {
    const fiveDeep = {
      and: [{ or: [{ not: { and: [{ status: { eq: "x" } }] } }] }],
    };
    expect(issuesOf({ ...base, where: fiveDeep })).toEqual([]);
    const sixDeep = {
      and: [{ or: [{ not: { and: [{ not: { status: { eq: "x" } } }] } }] }],
    };
    const issues = issuesOf({ ...base, where: sixDeep });
    expect(issues.map((i) => i.message).join(" ")).toMatch(/5 levels/);
  });

  it.each([
    ["an unknown top-level key", { ...base, raw: "SELECT 1" }],
    [
      "an unknown key on a join",
      { ...base, join: [{ relation: "a", on: "x" }] },
    ],
    [
      "an unknown key on a select item",
      { ...base, select: [{ count: "*", filter: "x" }] },
    ],
    ["an unknown operator", { ...base, where: { id: { like: "%" } } }],
    ["two operators on one path", { ...base, where: { id: { gt: 1, lt: 5 } } }],
    [
      "an aggregate with two functions",
      { ...base, select: [{ sum: "total", avg: "total" }] },
    ],
    ["a bucket without a column", { ...base, select: [{ bucket: "month" }] }],
    [
      "an unknown bucket unit",
      { ...base, select: [{ bucket: "hour", column: "created_at" }] },
    ],
    [
      "an alias with capitals",
      { ...base, select: [{ count: "*", as: "Total" }] },
    ],
    [
      "an alias starting with a digit",
      { ...base, select: [{ count: "*", as: "1x" }] },
    ],
    ["an alias with a quote", { ...base, select: [{ count: "*", as: 'a"b' }] }],
    ["an empty path segment", { ...base, select: ["customer..name"] }],
    ["a trailing dot", { ...base, select: ["customer."] }],
    ["a NUL in a path", { ...base, select: ["na\u0000me"] }],
    ["a NUL in a value", { ...base, where: { status: { eq: "a\u0000" } } }],
    ["an object as a value", { ...base, where: { id: { eq: { $gt: 1 } } } }],
    ["null as a value", { ...base, where: { id: { eq: null } } }],
    [
      "a between with three values",
      { ...base, where: { id: { between: [1, 2, 3] } } },
    ],
    ["isNull with a string", { ...base, where: { id: { isNull: "yes" } } }],
    ["contains with a number", { ...base, where: { id: { contains: 1 } } }],
    ["an empty filter", { ...base, where: {} }],
    ["an empty and", { ...base, where: { and: [] } }],
    [
      "and beside a path",
      { ...base, where: { and: [{ id: { eq: 1 } }], id: { eq: 1 } } },
    ],
    [
      "an orderBy entry with two keys",
      { ...base, orderBy: [{ id: "asc", status: "desc" }] },
    ],
    ["an orderBy entry with no key", { ...base, orderBy: [{}] }],
    ["an unknown direction", { ...base, orderBy: [{ id: "up" }] }],
    [
      "a join type other than inner or left",
      { ...base, join: [{ relation: "a", type: "cross" }] },
    ],
    [
      "the same join twice",
      { ...base, join: ["customer", { relation: "customer" }] },
    ],
    ["a select item that is a number", { ...base, select: [1] }],
  ])("refuses %s", (_, query) => {
    expect(issuesOf(query)).not.toEqual([]);
  });

  it("puts the path of the offending part in the issue", () => {
    const issues = issuesOf({
      ...base,
      where: { and: [{ id: { eq: 1 } }, { id: { gt: 1, lt: 2 } }] },
    });
    expect(issues.map((i) => i.path)).toContainEqual(["where", "and", 1, "id"]);
  });
});

describe("sqlLanguage", () => {
  it("is the sql language with the schema and the planner", () => {
    expect(sqlLanguage.id).toBe("sql");
    expect(sqlLanguage.schema).toBe(sqlQuerySchema);
  });

  it("describes itself as a JSON Schema", () => {
    const described = sqlLanguage.describe() as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(described.type).toBe("object");
    expect(Object.keys(described.properties)).toEqual(
      expect.arrayContaining([
        "source",
        "from",
        "join",
        "select",
        "where",
        "orderBy",
      ])
    );
    expect(described.required).toEqual(
      expect.arrayContaining(["source", "from", "select"])
    );
    expect(described.additionalProperties).toBe(false);
    expect(() => JSON.stringify(described)).not.toThrow();
  });
});

const calcPaths = (select: unknown) =>
  issuesOf({ ...base, select: [select] }).map((i) => i.path);

/** `{ abs: { abs: … "a" } }` with `levels` operation objects. */
const absChain = (levels: number): unknown =>
  levels === 0 ? "a" : { abs: absChain(levels - 1) };

/** `{ abs: … leaf }` with `levels` abs objects around `leaf`. */
const nest = (levels: number, leaf: unknown): unknown =>
  levels === 0 ? leaf : { abs: nest(levels - 1, leaf) };

describe("calculations", () => {
  it.each([
    [
      "a row-level calculation",
      {
        calc: {
          mul: ["unitprice", { sub: [1, "unitpricediscount"] }, "orderqty"],
        },
        as: "line_total",
      },
    ],
    [
      "an aggregate over an expression",
      { sum: { mul: ["a", "b"] }, as: "revenue" },
    ],
    ["an aggregate over a path with no as", { sum: "a" }],
    [
      "a ratio of aggregates",
      { calc: { div: [{ sum: "profit" }, { sum: "revenue" }] }, as: "margin" },
    ],
    [
      "count and countDistinct inside a calculation",
      { calc: { div: [{ count: "*" }, { countDistinct: "id" }] }, as: "ratio" },
    ],
    [
      "a text literal",
      { calc: { concat: ["first", { value: " " }, "last"] }, as: "name" },
    ],
    [
      "round with places",
      { calc: { round: [{ div: ["a", "b"] }, 2] }, as: "r" },
    ],
    ["round with one operand", { calc: { round: "a" }, as: "r" }],
    [
      "lower, upper, abs and coalesce",
      {
        calc: { coalesce: [{ lower: "a" }, { upper: "b" }, { value: "x" }] },
        as: "c",
      },
    ],
    ["a number literal", { calc: { add: ["a", 1.5] }, as: "c" }],
    [
      "a case with an else",
      {
        calc: {
          case: {
            when: [{ if: { a: { eq: "x" } }, then: 1 }],
            else: { add: ["b", 1] },
          },
        },
        as: "c",
      },
    ],
    [
      "a sum over a case",
      {
        sum: {
          case: {
            when: [
              { if: { a: { eq: "x" } }, then: "b" },
              { if: { or: [{ a: { isNull: true } }] }, then: 0 },
            ],
          },
        },
        as: "s",
      },
    ],
    [
      "date, timestamp and relative literals",
      {
        calc: {
          coalesce: [
            "a",
            { date: "2026-01-31" },
            { relative: { unit: "day", offset: -1 } },
          ],
        },
        as: "d",
      },
    ],
    [
      "a timestamp literal",
      { calc: { max: { timestamp: "2026-01-31T10:00:00Z" } }, as: "t" },
    ],
    [
      "dateAdd, dateDiff and datePart",
      {
        calc: {
          add: [
            { dateDiff: ["month", { dateAdd: ["a", -10000, "year"] }, "b"] },
            { datePart: ["fiscal_quarter", "c"] },
          ],
        },
        as: "d",
      },
    ],
    [
      "count and countDistinct over an expression",
      { count: { lower: "a" }, as: "n" },
    ],
    [
      "countDistinct over an expression",
      { countDistinct: { abs: "a" }, as: "n" },
    ],
    ["depth 8", { calc: absChain(8), as: "c" }],
  ])("accepts %s", (_name, item) => {
    const query = { ...base, select: [item] };
    expect(sqlQuerySchema.parse(query)).toEqual(query);
  });

  it.each([
    ["a calc without as", { calc: { add: ["a", "b"] } }, ["select", 0, "as"]],
    [
      "an aggregate over an expression without as",
      { sum: { mul: ["a", "b"] } },
      ["select", 0, "as"],
    ],
    [
      "sub with three operands",
      { calc: { sub: ["a", "b", "c"] }, as: "x" },
      ["select", 0, "calc", "sub"],
    ],
    [
      "add with one operand",
      { calc: { add: ["a"] }, as: "x" },
      ["select", 0, "calc", "add"],
    ],
    [
      "add with eleven operands",
      { calc: { add: Array(11).fill("a") }, as: "x" },
      ["select", 0, "calc", "add"],
    ],
    [
      "round with eleven places",
      { calc: { round: ["a", 11] }, as: "x" },
      ["select", 0, "calc", "round", 1],
    ],
    [
      "round with fractional places",
      { calc: { round: ["a", 1.5] }, as: "x" },
      ["select", 0, "calc", "round", 1],
    ],
    [
      "two keys in one operation",
      { calc: { add: ["a", "b"], abs: "c" }, as: "x" },
      ["select", 0, "calc"],
    ],
    [
      "an unknown operation",
      { calc: { pow: ["a", 2] }, as: "x" },
      ["select", 0, "calc"],
    ],
    [
      "an aggregate inside an aggregate",
      { sum: { sum: "a" }, as: "x" },
      ["select", 0, "sum", "sum"],
    ],
    [
      "an aggregate inside an aggregate inside a calculation",
      { calc: { add: [{ avg: { mul: ["a", { max: "b" }] } }, 1] }, as: "x" },
      ["select", 0, "calc", "add", 0, "avg", "mul", 1, "max"],
    ],
    [
      "depth 9",
      { calc: absChain(9), as: "x" },
      ["select", 0, "calc", ...Array(9).fill("abs")],
    ],
    [
      "countDistinct of *",
      { calc: { countDistinct: "*" }, as: "x" },
      ["select", 0, "calc", "countDistinct"],
    ],
    [
      "a dateAdd amount of 10,001",
      { calc: { dateAdd: ["a", 10001, "day"] }, as: "x" },
      ["select", 0, "calc", "dateAdd", 1],
    ],
    [
      "a dateAdd amount that is not an integer",
      { calc: { dateAdd: ["a", 1.5, "day"] }, as: "x" },
      ["select", 0, "calc", "dateAdd", 1],
    ],
    [
      "a dateAdd unit that is not a date unit",
      { calc: { dateAdd: ["a", 1, "hour"] }, as: "x" },
      ["select", 0, "calc", "dateAdd", 2],
    ],
    [
      "a datePart part that is unknown",
      { calc: { datePart: ["century", "a"] }, as: "x" },
      ["select", 0, "calc", "datePart", 0],
    ],
    [
      "a date literal with a stray key",
      { calc: { date: "2026-01-01", value: "x" }, as: "x" },
      ["select", 0, "calc"],
    ],
    [
      "a case with no branches",
      { calc: { case: { when: [] } }, as: "x" },
      ["select", 0, "calc", "case", "when"],
    ],
    [
      "a case with eleven branches",
      {
        calc: {
          case: {
            when: Array(11).fill({ if: { a: { eq: "x" } }, then: 1 }),
          },
        },
        as: "x",
      },
      ["select", 0, "calc", "case", "when"],
    ],
    [
      "a case branch with an unknown key",
      {
        calc: {
          case: { when: [{ if: { a: { eq: 1 } }, then: 1, when: 2 }] },
        },
        as: "x",
      },
      ["select", 0, "calc", "case", "when", 0],
    ],
    [
      "a case with an unknown key",
      {
        calc: { case: { when: [{ if: { a: { eq: 1 } }, then: 1 }], or: 1 } },
        as: "x",
      },
      ["select", 0, "calc", "case"],
    ],
    [
      "a case with a bad operator in an if",
      {
        calc: { case: { when: [{ if: { a: { like: "x" } }, then: 1 }] } },
        as: "x",
      },
      ["select", 0, "calc", "case", "when", 0, "if", "a"],
    ],
    [
      "a case nested past the depth limit",
      {
        calc: nest(8, { case: { when: [{ if: { a: { eq: 1 } }, then: 1 }] } }),
        as: "x",
      },
      ["select", 0, "calc", ...Array(8).fill("abs"), "case"],
    ],
    [
      "countDistinct of * as a select item",
      { countDistinct: "*", as: "x" },
      ["select", 0, "countDistinct"],
    ],
    [
      "a count over an expression without as",
      { count: { abs: "a" } },
      ["select", 0, "as"],
    ],
    [
      "a text literal over 1000 characters",
      { calc: { value: "x".repeat(1001) }, as: "x" },
      ["select", 0, "calc", "value"],
    ],
    [
      "a text literal with NUL",
      { calc: { value: "a\u0000b" }, as: "x" },
      ["select", 0, "calc", "value"],
    ],
    [
      "a boolean literal",
      { calc: { add: [true, 1] }, as: "x" },
      ["select", 0, "calc", "add", 0],
    ],
  ])("refuses %s", (_name, item, path) => {
    expect(calcPaths(item)).toContainEqual(path);
  });

  it("allows 100 operation and aggregate objects and refuses 101, at the first item over", () => {
    // Each item: add + 9 abs = 10 objects.
    const item = {
      calc: { add: Array(9).fill({ abs: "a" }).concat("b") },
      as: "",
    };
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...item, as: `c${i}` }));
    expect(
      sqlQuerySchema.safeParse({ ...base, select: items(10) }).success
    ).toBe(true);

    const over = [...items(10), { calc: { abs: "a" }, as: "extra" }];
    expect(issuesOf({ ...base, select: over })).toEqual([
      expect.objectContaining({ path: ["select", 10] }),
    ]);
  });

  it("counts an aggregate over an expression and its operands", () => {
    const select = [
      ...Array.from({ length: 49 }, (_, i) => ({
        calc: { add: Array(1).fill({ abs: "a" }).concat("b") },
        as: `c${i}`,
      })),
      { sum: { add: [{ abs: "a" }, { abs: "b" }, { abs: "c" }] }, as: "s" },
    ];
    // 49 * 2 = 98, then 1 + 1 + 3 = 5 more.
    expect(issuesOf({ ...base, select })).toEqual([
      expect.objectContaining({ path: ["select", 49] }),
    ]);
  });

  it("counts a case and its branch expressions", () => {
    const item = (i: number) => ({
      calc: {
        case: {
          when: [{ if: { a: { eq: 1 } }, then: { abs: "a" } }],
          else: { abs: "b" },
        },
      },
      as: `c${i}`,
    });
    // case + 2 abs = 3 objects per item.
    const items = (n: number) => Array.from({ length: n }, (_, i) => item(i));
    expect(
      sqlQuerySchema.safeParse({ ...base, select: items(33) }).success
    ).toBe(true);
    expect(issuesOf({ ...base, select: items(34) })).toEqual([
      expect.objectContaining({ path: ["select", 33] }),
    ]);
  });

  it("describes case and count over an expression in its JSON Schema", () => {
    const text = JSON.stringify(sqlLanguage.describe());
    expect(text).toContain('"case"');
    expect(text).toContain('"maxItems":10');
  });

  it("names calc beside the existing forms in a select item's error", () => {
    const issues = issuesOf({ ...base, select: [{ nope: 1 }] });
    expect(issues[0]?.message).toContain("{ calc: expression, as }");
    expect(issues[0]?.message.length).toBeLessThanOrEqual(256);
  });

  it("exports the limits", async () => {
    const language = await import("../../../adapters/sql/language.js");
    expect([
      language.MAX_CALC_DEPTH,
      language.MAX_CALC_NODES,
      language.MAX_CALC_OPERANDS,
      language.MAX_ROUND_PLACES,
    ]).toEqual([8, 100, 10, 10]);
    expect(language.CALC_OPS).toHaveLength(10);
  });
});

// A JSON Schema walked by path; its shape is what the tests assert.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const described = () => sqlLanguage.describe() as Json;
const forms = (def: Json): Json[] => def.anyOf;
const operationNamed = (key: string): Json =>
  forms(described().$defs.CalcExpr).find((f) => f.properties?.[key])!;

describe("sqlLanguage.describe, calculations", () => {
  it("points select items and calculations at structured definitions", () => {
    const schema = described();
    const select = schema.$defs[schema.properties.select.$ref.split("/").pop()];
    expect(select.items.$ref).toBe("#/$defs/SelectItem");
    expect(Object.keys(schema.$defs)).toEqual(
      expect.arrayContaining(["CalcExpr", "SelectItem"])
    );
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it("shows every select item form, with calc requiring its name", () => {
    const items = forms(described().$defs.SelectItem);
    const keys = items
      .filter((i) => i.type === "object")
      .map(
        (i) =>
          Object.keys(i.properties).filter(
            (k) => k !== "as" && k !== "column"
          )[0]
      );
    expect(keys).toEqual([
      "count",
      "countDistinct",
      "sum",
      "avg",
      "min",
      "max",
      "bucket",
      "calc",
    ]);
    const calc = items.find((i) => i.properties?.calc)!;
    expect(calc.required).toEqual(["calc", "as"]);
    expect(calc.properties.calc.$ref).toBe("#/$defs/CalcExpr");
  });

  it("shows paths, numbers and text literals as expressions", () => {
    const expr = forms(described().$defs.CalcExpr);
    expect(expr.map((f) => f.type).slice(0, 3)).toEqual([
      "string",
      "number",
      "object",
    ]);
    expect(expr[2]!.required).toEqual(["value"]);
  });

  it("gives operations their operand counts", () => {
    for (const key of ["add", "mul", "concat", "coalesce"]) {
      expect(operationNamed(key).properties[key]).toMatchObject({
        type: "array",
        minItems: 2,
        maxItems: 10,
      });
    }
    for (const key of ["sub", "div"]) {
      expect(operationNamed(key).properties[key]).toMatchObject({
        minItems: 2,
        maxItems: 2,
      });
    }
    expect(operationNamed("abs").properties.abs.$ref).toBe("#/$defs/CalcExpr");
    expect(operationNamed("lower").additionalProperties).toBe(false);
  });

  it("shows round's two forms and its places", () => {
    const [single, pair] = operationNamed("round").properties.round.anyOf;
    expect(single.$ref).toBe("#/$defs/CalcExpr");
    expect(pair.prefixItems[1]).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 10,
    });
  });

  it("shows aggregates inside expressions", () => {
    for (const key of ["sum", "avg", "min", "max", "count", "countDistinct"]) {
      expect(operationNamed(key)).toBeDefined();
    }
  });
});
