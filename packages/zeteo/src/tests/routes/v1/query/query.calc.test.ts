// @module-tag int
// @module-tag platform
import { describeEachEngine } from "../../../support/engines.js";
import { removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// The portable fixture's orders: decimal totals (numeric(12,2) and
// decimal(12,2)), 64-bit external refs past 2^53 and nulls, nullable notes,
// and a money ledger. Numbers are compared by value, as the engines may print
// different digits; `round` and `concat` must print the same text on both.

describeEachEngine("POST /v1/query: calculations", (engine) => {
  let source: SeededSource;
  const user = newQueryUser();

  const query = (body: Record<string, unknown>) =>
    postQuery(user.token, { source: source.slug, ...body });

  const rowsOf = async (body: Record<string, unknown>) => {
    const res = await query(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.rows as unknown[][];
  };

  /** Rows with every number (or numeric text) read as a JS number; nulls kept. */
  const numeric = (rows: unknown[][]) =>
    rows.map((row) => row.map((v) => (v === null ? null : Number(v))));

  const calcs = (...items: [string, unknown][]) =>
    items.map(([as, calc]) => ({ calc, as }));

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "calc");
    for (const table of ["accounts", "customers", "orders", "ledger"]) {
      await grantTo(user.principal, source.tables[table]!, "all");
    }
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
  });

  it("adds, subtracts, multiplies and takes absolute values per row", async () => {
    const res = await query({
      from: "orders",
      select: [
        "id",
        ...calcs(
          ["plus", { add: ["total", 1, 0.25] }],
          ["minus", { sub: ["total", "id"] }],
          ["times", { mul: ["total", 2, "id"] }],
          ["distance", { abs: { sub: ["id", 10] } }]
        ),
      ],
      where: { id: { in: [1, 2] } },
      orderBy: [{ id: "asc" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { type: string }) => c.type)).toEqual([
      "number",
      "number",
      "number",
      "number",
      "number",
    ]);
    expect(numeric(res.body.rows)).toEqual([
      [1, 11.25, 9, 20, 9],
      [2, 251.75, 248.5, 1002, 8],
    ]);
  });

  it("divides integers without truncating, and by zero as null, row by row", async () => {
    const rows = await rowsOf({
      from: "orders",
      select: [
        "id",
        ...calcs(
          ["half", { div: ["id", 2] }],
          ["literal", { div: [7, 2] }],
          ["third", { div: ["total", 3] }],
          ["by_zero", { div: ["total", { sub: ["id", "id"] }] }],
          ["by_literal_zero", { div: ["total", 0] }]
        ),
      ],
      where: { id: { in: [2, 7] } },
      orderBy: [{ id: "asc" }],
    });
    expect(numeric(rows)).toEqual([
      [2, 1, 3.5, 83.5, null, null],
      [7, 3.5, 3.5, 6.133333, null, null],
    ]);
  });

  it("gives null for a group whose denominator aggregate sums to zero", async () => {
    const rows = await rowsOf({
      from: "orders",
      select: [
        "status",
        ...calcs(
          [
            "ratio",
            { div: [{ sum: "total" }, { sum: { sub: ["id", "id"] } }] },
          ],
          ["mean", { div: [{ sum: "total" }, { count: "*" }] }]
        ),
      ],
      groupBy: ["status"],
      orderBy: [{ status: "asc" }],
    });
    expect(
      rows.map(([status, ratio, mean]) => [status, ratio, Number(mean)])
    ).toEqual([
      ["cancelled", null, 5.25],
      ["paid", null, 512.227143],
      ["pending", null, 33.33],
      ["shipped", null, 43.463333],
    ]);
  });

  it("rounds half away from zero to exactly the requested places", async () => {
    const rows = await rowsOf({
      from: "orders",
      select: [
        "id",
        ...calcs(
          ["whole", { round: "total" }],
          ["one", { round: [{ mul: ["total", -1] }, 1] }],
          ["three", { round: ["total", 3] }],
          ["third", { round: [{ div: ["total", 3] }, 2] }]
        ),
      ],
      where: { id: { in: [1, 2, 5] } },
      orderBy: [{ id: "asc" }],
    });
    expect(rows).toEqual([
      [1, "10", "-10.0", "10.000", "3.33"],
      [2, "251", "-250.5", "250.500", "83.50"],
      [5, "5", "-5.3", "5.250", "1.75"],
    ]);
  });

  it("rounds money and negatives half away from zero", async () => {
    const rows = await rowsOf({
      from: "ledger",
      select: ["id", ...calcs(["tenth", { round: ["amount", 1] }])],
      orderBy: [{ id: "asc" }],
    });
    expect(rows).toEqual([
      [1, "1234.5"],
      [2, "1.0"],
      [3, "-12.3"],
      [4, null],
    ]);
  });

  it("concatenates with nulls as empty text and numbers as the same decimal text", async () => {
    const rows = await rowsOf({
      from: "orders",
      select: [
        "id",
        ...calcs(
          ["label", { concat: ["total", { value: " EUR" }] }],
          [
            "ref",
            {
              concat: [{ value: "#" }, "external_ref", { value: "|" }, "notes"],
            },
          ],
          ["nothing", { concat: ["notes", "external_ref"] }],
          ["literal", { concat: [12.5, { value: "/" }, 7] }]
        ),
      ],
      where: { id: { in: [1, 2, 11] } },
      orderBy: [{ id: "asc" }],
    });
    expect(rows).toEqual([
      [1, "10.00 EUR", "#|", "", "12.5/7"],
      [
        2,
        "250.50 EUR",
        "#9007199254740993|rush",
        "rush9007199254740993",
        "12.5/7",
      ],
      [11, "12.00 EUR", "#9|", "9", "12.5/7"],
    ]);
  });

  it("concatenates money, decimals below one and negatives as the same text", async () => {
    const rows = await rowsOf({
      from: "ledger",
      select: ["id", ...calcs(["text", { concat: ["amount", { value: "" }] }])],
      orderBy: [{ id: "asc" }],
    });
    expect(rows).toEqual([
      [1, "1234.50"],
      [2, "0.99"],
      [3, "-12.25"],
      [4, ""],
    ]);
  });

  it("lowers, uppers and coalesces", async () => {
    const rows = await rowsOf({
      from: "orders",
      join: ["customers"],
      select: [
        "id",
        ...calcs(
          ["low", { lower: "customers.name" }],
          ["up", { upper: "customers.name" }],
          ["note", { coalesce: ["notes", { value: "-" }] }],
          ["ref", { coalesce: ["external_ref", 0] }]
        ),
      ],
      where: { id: { in: [1, 4] } },
      orderBy: [{ id: "asc" }],
    });
    expect(rows.map((r) => [...r.slice(0, 4), Number(r[4])])).toEqual([
      [1, "acme", "ACME", "-", 0],
      [4, "mixed case ltd", "MIXED CASE LTD", "gift wrap", 0],
    ]);
  });

  it("computes a group-level average order value by plan through two joins", async () => {
    const rows = await rowsOf({
      from: "orders",
      join: ["customers", "customers.accounts"],
      select: [
        "customers.accounts.plan",
        {
          calc: {
            round: [{ div: [{ sum: "total" }, { countDistinct: "id" }] }, 2],
          },
          as: "aov",
        },
      ],
      groupBy: ["customers.accounts.plan"],
      orderBy: [{ aov: "desc" }],
    });
    expect(rows).toEqual([
      ["starter", "577.08"],
      ["enterprise", "180.78"],
    ]);
  });

  it("filters on a row calc in where and on a group calc in having", async () => {
    expect(
      numeric(
        await rowsOf({
          from: "orders",
          select: ["id", ...calcs(["double", { mul: ["total", 2] }])],
          where: { double: { gt: 1000 } },
          orderBy: [{ id: "asc" }],
        })
      )
    ).toEqual([
      [4, 2400],
      [8, 1280.2],
      [12, 1999.98],
    ]);
    const rows = await rowsOf({
      from: "orders",
      select: [
        "status",
        ...calcs(["mean", { div: [{ sum: "total" }, { count: "*" }] }]),
      ],
      groupBy: ["status"],
      having: { mean: { gt: 100 } },
    });
    expect(rows.map(([s, m]) => [s, Number(m)])).toEqual([
      ["paid", 512.227143],
    ]);
  });

  it("groups by a row calc holding a literal", async () => {
    const rows = await rowsOf({
      from: "orders",
      select: [
        ...calcs(["tens", { mul: ["customer_id", 10] }]),
        { count: "*", as: "n" },
      ],
      groupBy: ["tens"],
    });
    expect(numeric(rows)).toEqual([
      [10, 4],
      [20, 4],
      [30, 4],
    ]);
  });

  it("answers an integer overflow with 502 query_failed, recorded as failed", async () => {
    const res = await query({
      from: "orders",
      select: [
        "id",
        ...calcs(["square", { mul: ["external_ref", "external_ref"] }]),
      ],
      where: { id: { eq: 2 } },
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "query_failed",
      error_description: "The source could not run the query",
      request_id: expect.any(String),
    });
    expect((await runsOf([user.id])).at(-1)).toMatchObject({
      outcome: "failed",
      errorCode: "query_failed",
    });
  });
});
