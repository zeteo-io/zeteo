// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeEachEngine } from "../../../support/engines.js";
import { removeSources } from "../../../support/sources.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// Expected rows are literals shared by every engine: the portable fixture
// tables only, and no `eq` or ordering on text whose case differs.

describeEachEngine("POST /v1/query", (engine) => {
  let source: SeededSource;
  const user = newQueryUser();

  const query = (body: Record<string, unknown>) =>
    postQuery(user.token, { source: source.slug, ...body });

  /** The rows of a query that must succeed. */
  const rowsOf = async (body: Record<string, unknown>) => {
    const res = await query(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.rows as unknown[][];
  };

  beforeAll(async () => {
    source = await seedQuerySource(engine);
    for (const table of ["accounts", "customers", "orders", "ledger"]) {
      await grantTo(user.principal, source.tables[table]!, "all");
    }
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
  });

  it("answers the spec's example: join, bucket, sum, filter, group, having and order", async () => {
    const res = await query({
      from: "orders",
      join: ["customer"],
      select: [
        "customer.region",
        { bucket: "month", column: "created_at", as: "month" },
        { sum: "total", as: "revenue" },
      ],
      where: { status: { in: ["paid", "shipped"] } },
      groupBy: ["customer.region", "month"],
      having: { revenue: { gt: 100 } },
      orderBy: [{ revenue: "desc" }],
      limit: 1000,
      offset: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      columns: [
        { name: "customer.region", type: "text" },
        { name: "month", type: "timestamp" },
        { name: "revenue", type: "number" },
      ],
      rows: [
        ["EU", "2026-02-01T00:00:00.000Z", "1200.00"],
        ["EU", "2026-06-01T00:00:00.000Z", "999.99"],
        ["US", "2026-04-01T00:00:00.000Z", "640.10"],
        ["EU", "2026-05-01T00:00:00.000Z", "410.00"],
        ["EU", "2026-01-01T00:00:00.000Z", "260.50"],
      ],
      truncated: false,
      warnings: [],
      run_id: expect.any(String),
    });
  });

  it("follows a relation two joins deep", async () => {
    expect(
      await rowsOf({
        from: "orders",
        join: ["customer", "customer.account"],
        select: ["customer.account.plan", { count: "*", as: "n" }],
        groupBy: ["customer.account.plan"],
      })
    ).toEqual([
      ["enterprise", "8"],
      ["starter", "4"],
    ]);
  });

  it("left-joins along a relation to many rows", async () => {
    expect(
      await rowsOf({
        from: "accounts",
        join: [{ relation: "customers", type: "left" }],
        select: ["id", "customers.id"],
      })
    ).toEqual([
      [1, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("warns when a join to many rows sits under an aggregate", async () => {
    const res = await query({
      from: "customers",
      join: ["orders"],
      select: [{ count: "*" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([["12"]]);
    expect(res.body.warnings).toEqual([
      {
        code: "join_multiplies_rows",
        message: expect.any(String),
        path: ["join", 0],
      },
    ]);
  });

  it("computes each aggregate, in its wire form", async () => {
    const res = await query({
      from: "orders",
      select: [
        { count: "*" },
        { count: "notes", as: "with_notes" },
        { countDistinct: "customer_id" },
        { sum: "total" },
        { sum: "customer_id", as: "sum_int" },
        { sum: "external_ref", as: "sum_big" },
        { avg: "total" },
        { min: "total" },
        { max: "total" },
        { min: "created_at" },
        { max: "created_at" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      "count",
      "with_notes",
      "countDistinct_customer_id",
      "sum_total",
      "sum_int",
      "sum_big",
      "avg_total",
      "min_total",
      "max_total",
      "min_created_at",
      "max_created_at",
    ]);
    expect(res.body.rows).toEqual([
      [
        "12",
        "6",
        "3",
        "3754.56",
        "24",
        "9007322711529998",
        312.88,
        "5.25",
        "1200.00",
        "2026-01-05T09:00:00.000Z",
        "2026-06-30T12:00:00.000Z",
      ],
    ]);
  });

  it.each([
    [
      "day",
      [
        ["2026-03-01T00:00:00.000Z", "1"],
        ["2026-03-31T00:00:00.000Z", "1"],
        ["2026-04-01T00:00:00.000Z", "1"],
      ],
    ],
    [
      "week",
      [
        ["2026-02-23T00:00:00.000Z", "1"],
        ["2026-03-30T00:00:00.000Z", "2"],
      ],
    ],
    [
      "month",
      [
        ["2026-03-01T00:00:00.000Z", "2"],
        ["2026-04-01T00:00:00.000Z", "1"],
      ],
    ],
    [
      "quarter",
      [
        ["2026-01-01T00:00:00.000Z", "2"],
        ["2026-04-01T00:00:00.000Z", "1"],
      ],
    ],
    ["year", [["2026-01-01T00:00:00.000Z", "3"]]],
  ])("buckets by %s in UTC, weeks from Monday", async (unit, rows) => {
    expect(
      await rowsOf({
        from: "orders",
        select: [
          { bucket: unit, column: "created_at", as: "b" },
          { count: "*", as: "n" },
        ],
        where: { id: { in: [5, 6, 7] } },
        groupBy: ["b"],
      })
    ).toEqual(rows);
  });

  it.each([
    ["eq", { status: { eq: "shipped" } }, [3, 7, 11]],
    ["ne", { status: { ne: "paid" } }, [3, 5, 7, 9, 11]],
    ["gt", { total: { gt: 640.1 } }, [4, 12]],
    ["gte", { total: { gte: "640.10" } }, [4, 8, 12]],
    ["lt", { total: { lt: 12 } }, [1, 5]],
    ["lte", { total: { lte: 12 } }, [1, 5, 11]],
    ["between", { total: { between: [18.4, "99.99"] } }, [3, 6, 7, 9]],
    ["in", { status: { in: ["pending", "cancelled"] } }, [5, 9]],
    ["notIn", { status: { notIn: ["paid", "shipped"] } }, [5, 9]],
    ["contains, ignoring case", { notes: { contains: "CALL" } }, [8]],
    ["startsWith, ignoring case", { notes: { startsWith: "GIFT" } }, [4]],
    ["isNull true", { notes: { isNull: true } }, [1, 3, 5, 7, 9, 11]],
    ["isNull false", { notes: { isNull: false } }, [2, 4, 6, 8, 10, 12]],
    [
      "gte on a timestamp, as an instant",
      { created_at: { gte: "2026-06-10T11:40:10.5+01:30" } },
      [11, 12],
    ],
    [
      "eq on a 64-bit integer past 2^53",
      { external_ref: { eq: "9007199254740993" } },
      [2],
    ],
    [
      "or",
      { or: [{ status: { eq: "cancelled" } }, { total: { gt: 1000 } }] },
      [4, 5],
    ],
    [
      "and",
      { and: [{ status: { eq: "paid" } }, { total: { lt: 100 } }] },
      [1, 6],
    ],
    ["not", { not: { status: { in: ["paid", "shipped"] } } }, [5, 9]],
    [
      "several paths in one object, all of them",
      { status: { eq: "paid" }, customer_id: { eq: 3 } },
      [4, 6, 12],
    ],
  ])("filters with %s", async (_, where, ids) => {
    expect(
      await rowsOf({
        from: "orders",
        select: ["id"],
        where,
        orderBy: [{ id: "asc" }],
      })
    ).toEqual(ids.map((id) => [id]));
  });

  it.each([
    ["%", [2]],
    ["_", [2]],
    ["% organic_", [2]],
    ["ORGANIC", [2]],
    ["case l", [3]],
  ])("matches %j in text literally with contains", async (value, ids) => {
    expect(
      await rowsOf({
        from: "customers",
        select: ["id"],
        where: { name: { contains: value } },
      })
    ).toEqual(ids.map((id) => [id]));
  });

  it("puts nulls last ascending and first descending", async () => {
    const order = (direction: "asc" | "desc") =>
      rowsOf({
        from: "orders",
        select: ["id", "external_ref"],
        orderBy: [{ external_ref: direction }, { id: "asc" }],
      });
    expect(await order("asc")).toEqual([
      [5, "-42"],
      [3, "1"],
      [8, "7"],
      [10, "8"],
      [11, "9"],
      [12, "10"],
      [6, "123456789012"],
      [2, "9007199254740993"],
      [1, null],
      [4, null],
      [7, null],
      [9, null],
    ]);
    expect(await order("desc")).toEqual([
      [1, null],
      [4, null],
      [7, null],
      [9, null],
      [2, "9007199254740993"],
      [6, "123456789012"],
      [12, "10"],
      [11, "9"],
      [10, "8"],
      [8, "7"],
      [3, "1"],
      [5, "-42"],
    ]);
  });

  it("orders by a column it does not select", async () => {
    expect(
      await rowsOf({
        from: "orders",
        select: ["id"],
        where: { status: { eq: "shipped" } },
        orderBy: [{ total: "desc" }],
      })
    ).toEqual([[3], [7], [11]]);
  });

  it("pages in a stable default order: the select items, ascending", async () => {
    const all = [
      ["cancelled", 5],
      ["paid", 1],
      ["paid", 2],
      ["paid", 4],
      ["paid", 6],
      ["paid", 8],
      ["paid", 10],
      ["paid", 12],
      ["pending", 9],
      ["shipped", 3],
      ["shipped", 7],
      ["shipped", 11],
    ];
    const page = (offset: number) =>
      query({ from: "orders", select: ["status", "id"], limit: 5, offset });
    const pages = [await page(0), await page(5), await page(10)];
    expect(pages.map((p) => p.body.rows)).toEqual([
      all.slice(0, 5),
      all.slice(5, 10),
      all.slice(10),
    ]);
    expect(pages.map((p) => p.body.truncated)).toEqual([true, true, false]);
    expect(pages[0]!.body.truncated_by).toBe("rows");
    expect(pages[2]!.body).not.toHaveProperty("truncated_by");
  });

  it("answers no rows past the end", async () => {
    expect(
      await rowsOf({ from: "orders", select: ["id"], offset: 12 })
    ).toEqual([]);
  });

  it("returns each distinct row once", async () => {
    expect(
      await rowsOf({ from: "orders", select: ["status"], distinct: true })
    ).toEqual([["cancelled"], ["paid"], ["pending"], ["shipped"]]);
  });

  it("filters groups with having", async () => {
    expect(
      await rowsOf({
        from: "orders",
        select: ["customer_id", { sum: "total", as: "revenue" }],
        groupBy: ["customer_id"],
        having: { revenue: { lt: 1000 } },
      })
    ).toEqual([
      [1, "688.90"],
      [2, "757.34"],
    ]);
  });

  it("returns each type in its wire form", async () => {
    const res = await query({
      from: "orders",
      select: ["id", "total", "created_at", "external_ref", "notes"],
      where: { id: { in: [2, 11] } },
    });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual([
      { name: "id", type: "number" },
      { name: "total", type: "number" },
      { name: "created_at", type: "timestamp" },
      { name: "external_ref", type: "number" },
      { name: "notes", type: "text" },
    ]);
    expect(res.body.rows).toEqual([
      [2, "250.50", "2026-01-20T14:30:00.000Z", "9007199254740993", "rush"],
      [11, "12.00", "2026-06-10T10:10:10.500Z", "9", null],
    ]);
  });

  it("answers a query the planner refuses with 422, its path and no rows", async () => {
    const res = await query({
      from: "orders",
      select: ["id"],
      where: { status: { gt: true } },
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "invalid_value",
      error_description: expect.any(String),
      path: ["where", "status", "gt"],
      suggestions: [],
    });
  });

  it("refuses a body the language rejects with 400 invalid_request and its issues", async () => {
    const res = await query({ from: "orders", select: [], bogus: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["select", ""])
    );
  });

  it("refuses a body without a source with 400 invalid_request", async () => {
    for (const body of [
      { from: "orders", select: ["id"] },
      { source: "", from: "orders", select: ["id"] },
      { source: 7, from: "orders", select: ["id"] },
      ["not", "an", "object"],
    ]) {
      const res = await postQuery(user.token, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
  });

  describe("uuid and money columns", () => {
    const ledgerIds = (where: Record<string, unknown>, more = {}) =>
      rowsOf({ from: "ledger", select: ["id"], where, ...more });

    it("compares a uuid whatever the case of the value", async () => {
      expect(
        await ledgerIds({
          ref: { eq: "6F1C1B2E-3C4D-4E5F-8A9B-0C1D2E3F4A5B" },
        })
      ).toEqual([[1]]);
      expect(
        await ledgerIds({
          ref: {
            in: [
              "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
              "00000000-0000-0000-0000-000000000003",
            ],
          },
        })
      ).toEqual([[2], [3]]);
      expect(
        await ledgerIds({
          ref: { ne: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" },
        })
      ).toEqual([[2], [3]]);
      expect(await ledgerIds({ ref: { isNull: true } })).toEqual([[4]]);
    });

    it("matches a uuid's text ignoring case", async () => {
      expect(await ledgerIds({ ref: { contains: "8A9B" } })).toEqual([[1]]);
      expect(await ledgerIds({ ref: { startsWith: "a0EE" } })).toEqual([[2]]);
    });

    it("counts uuids", async () => {
      expect(
        await rowsOf({
          from: "ledger",
          select: [
            { count: "ref", as: "n" },
            { countDistinct: "ref", as: "d" },
          ],
        })
      ).toEqual([["3", "3"]]);
    });

    it("filters money with decimals and integers", async () => {
      expect(await ledgerIds({ amount: { gt: "1.5" } })).toEqual([[1]]);
      expect(await ledgerIds({ amount: { lt: 0 } })).toEqual([[3]]);
      expect(await ledgerIds({ amount: { between: [0, 1] } })).toEqual([[2]]);
      expect(await ledgerIds({ amount: { in: [0.99, "1234.50"] } })).toEqual([
        [1],
        [2],
      ]);
    });

    it("averages and orders money", async () => {
      expect(
        await rowsOf({
          from: "ledger",
          select: [{ avg: "amount", as: "a" }],
          where: { id: { in: [1, 3] } },
        })
      ).toEqual([[611.125]]);
      expect(
        await rowsOf({
          from: "ledger",
          select: ["id"],
          orderBy: [{ amount: "desc" }],
        })
      ).toEqual([[4], [1], [2], [3]]);
    });

    it.each([
      ["eq", { eq: "not-a-uuid" }],
      ["in", { in: ["6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "nope"] }],
    ])(
      "refuses a malformed uuid (%s) with 422 invalid_value, recorded as refused",
      async (_, filter) => {
        const res = await query({
          from: "ledger",
          select: ["id"],
          where: { ref: filter },
        });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          error: "invalid_value",
          error_description:
            "A value in the query could not be converted to its column's type",
          path: [],
          suggestions: [],
        });
        expect((await runsOf([user.id])).at(-1)).toMatchObject({
          outcome: "refused",
          errorCode: "invalid_value",
        });
      }
    );
  });
});
