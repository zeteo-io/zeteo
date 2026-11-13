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
    ["5 joins", { join: ["a", "b", "c", "d", "e"] }, 4],
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
    ["4 joins", { join: ["a", "b", "c", "d"] }],
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
