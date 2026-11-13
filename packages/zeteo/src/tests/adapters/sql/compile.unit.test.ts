// @module-tag unit
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { shopCatalog } from "../../support/pure/shopCatalog.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { describe, expect, it } from "vitest";

const compile = (query: object, fetch = { limit: 1001, offset: 0 }) =>
  compileSql(
    planSql(
      sqlQuerySchema.parse({
        source: "shop",
        from: "orders",
        select: ["id"],
        ...query,
      }),
      shopCatalog()
    ),
    postgresDialect,
    fetch
  );

const tail = (used = 0) =>
  ` order by "c0" asc nulls last limit $${used + 1} offset $${used + 2}`;
const ORDERED = tail();

describe("compileSql on Postgres: shape", () => {
  it("selects columns positionally aliased, ordered by every item, paged by parameters", () => {
    expect(
      compile({ select: ["id", "status"] }, { limit: 11, offset: 20 })
    ).toEqual({
      sql:
        'select "t0"."id" as "c0", "t0"."status" as "c1" from "shop"."orders" as "t0"' +
        ' order by "c0" asc nulls last, "c1" asc nulls last limit $1 offset $2',
      parameters: [11, 20],
    });
  });

  it("ignores the query's own limit and offset in favour of fetch", () => {
    expect(
      compile({ limit: 5, offset: 7 }, { limit: 6, offset: 7 }).parameters
    ).toEqual([6, 7]);
  });

  it("addresses a table in another schema by schema and name", () => {
    expect(compile({ from: "billing.accounts", select: ["balance"] }).sql).toBe(
      'select "t0"."balance" as "c0" from "billing"."accounts" as "t0"' +
        ORDERED
    );
  });

  it("emits distinct", () => {
    expect(compile({ select: ["status"], distinct: true }).sql).toBe(
      'select distinct "t0"."status" as "c0" from "shop"."orders" as "t0"' +
        ORDERED
    );
  });

  it("orders by a select item explicitly, nulls first when descending", () => {
    expect(
      compile({
        select: ["id", "total"],
        orderBy: [{ total: "desc" }, { id: "asc" }],
      }).sql
    ).toBe(
      'select "t0"."id" as "c0", "t0"."total" as "c1" from "shop"."orders" as "t0"' +
        ' order by "c1" desc nulls first, "c0" asc nulls last limit $1 offset $2'
    );
  });

  it("orders by a column that is not selected", () => {
    expect(compile({ orderBy: [{ notes: "desc" }] }).sql).toBe(
      'select "t0"."id" as "c0" from "shop"."orders" as "t0"' +
        ' order by "t0"."notes" desc nulls first limit $1 offset $2'
    );
  });
});

describe("compileSql on Postgres: joins", () => {
  it("joins inner by default", () => {
    expect(
      compile({ join: ["customer"], select: ["customer.region"] }).sql
    ).toBe(
      'select "t1"."region" as "c0" from "shop"."orders" as "t0"' +
        ' inner join "shop"."customers" as "t1" on "t0"."customer_id" = "t1"."id"' +
        ORDERED
    );
  });

  it("joins left", () => {
    expect(
      compile({
        join: [{ relation: "lines", type: "left" }],
        select: ["lines.sku"],
      }).sql
    ).toBe(
      'select "t1"."sku" as "c0" from "shop"."orders" as "t0"' +
        ' left join "shop"."order_lines" as "t1" on "t0"."id" = "t1"."order_id"' +
        ORDERED
    );
  });

  it("joins a two-step path from the first join", () => {
    expect(
      compile({
        join: ["customer", "customer.account"],
        select: ["customer.account.plan"],
      }).sql
    ).toBe(
      'select "t2"."plan" as "c0" from "shop"."orders" as "t0"' +
        ' inner join "shop"."customers" as "t1" on "t0"."customer_id" = "t1"."id"' +
        ' inner join "shop"."accounts" as "t2" on "t1"."account_id" = "t2"."id"' +
        ORDERED
    );
  });
});

describe("compileSql on Postgres: aggregates and buckets", () => {
  it("compiles each aggregate", () => {
    expect(
      compile({
        select: [
          { count: "*", as: "n" },
          { count: "notes", as: "notes_n" },
          { countDistinct: "status", as: "statuses" },
          { sum: "total", as: "revenue" },
          { avg: "total", as: "mean" },
          { min: "total", as: "lowest" },
          { max: "total", as: "highest" },
        ],
      }).sql
    ).toBe(
      'select count(*) as "c0", count("t0"."notes") as "c1", count(distinct "t0"."status") as "c2",' +
        ' sum("t0"."total") as "c3", avg("t0"."total")::float8 as "c4", min("t0"."total") as "c5",' +
        ' max("t0"."total") as "c6" from "shop"."orders" as "t0"' +
        ' order by "c0" asc nulls last, "c1" asc nulls last, "c2" asc nulls last, "c3" asc nulls last,' +
        ' "c4" asc nulls last, "c5" asc nulls last, "c6" asc nulls last limit $1 offset $2'
    );
  });

  it("truncates a timestamp bucket with the unit as a parameter", () => {
    expect(
      compile({ select: [{ bucket: "month", column: "created_at", as: "m" }] })
    ).toEqual({
      sql:
        'select date_trunc($1, "t0"."created_at") as "c0" from "shop"."orders" as "t0"' +
        ' order by "c0" asc nulls last limit $2 offset $3',
      parameters: ["month", 1001, 0],
    });
  });

  it("casts a date bucket back to date", () => {
    expect(
      compile({ select: [{ bucket: "week", column: "ordered_on", as: "w" }] })
        .sql
    ).toBe(
      'select date_trunc($1, "t0"."ordered_on")::date as "c0" from "shop"."orders" as "t0"' +
        ' order by "c0" asc nulls last limit $2 offset $3'
    );
  });

  it("groups by position, so a bucket's parameter is not repeated, and filters groups with having", () => {
    expect(
      compile({
        select: [
          "status",
          { bucket: "month", column: "created_at", as: "month" },
          { sum: "total", as: "revenue" },
          { count: "*", as: "n" },
        ],
        groupBy: ["status", "month"],
        having: { and: [{ revenue: { gt: 1000 } }, { n: { gte: 2 } }] },
        orderBy: [{ revenue: "desc" }],
      })
    ).toEqual({
      sql:
        'select "t0"."status" as "c0", date_trunc($1, "t0"."created_at") as "c1",' +
        ' sum("t0"."total") as "c2", count(*) as "c3" from "shop"."orders" as "t0"' +
        ' group by 1, 2 having (sum("t0"."total") > $2 and count(*) >= $3)' +
        ' order by "c2" desc nulls first limit $4 offset $5',
      parameters: ["month", 1000, 2, 1001, 0],
    });
  });

  it("aggregates over all rows with no group by", () => {
    expect(compile({ select: [{ count: "*", as: "n" }] }).sql).toBe(
      'select count(*) as "c0" from "shop"."orders" as "t0"' + ORDERED
    );
  });

  it("compares a decimal with an aggregate through numeric, keeping an integer uncast", () => {
    const sums = (value: number | string) =>
      compile({
        select: [{ sum: "quantity", as: "q" }],
        from: "order_lines",
        having: { q: { gt: value } },
      });
    expect(sums(10).sql).toContain("having sum(");
    expect(sums(10).sql).toContain("> $1 order");
    expect(sums("10.5").sql).toContain("> cast($1 as numeric) order");
    expect(sums("10.5").parameters[0]).toBe("10.5");
  });
});

describe("compileSql on Postgres: filters", () => {
  const where = (filter: object, select = ["id"]) =>
    compile({ select, where: filter });
  const base = 'select "t0"."id" as "c0" from "shop"."orders" as "t0" where ';

  it.each([
    ["eq", { status: { eq: "paid" } }, '"t0"."status" = $1', ["paid"]],
    ["ne", { status: { ne: "paid" } }, '"t0"."status" <> $1', ["paid"]],
    ["gt", { id: { gt: 5 } }, '"t0"."id" > $1', [5]],
    ["gte", { id: { gte: 5 } }, '"t0"."id" >= $1', [5]],
    ["lt", { id: { lt: 5 } }, '"t0"."id" < $1', [5]],
    ["lte", { id: { lte: 5 } }, '"t0"."id" <= $1', [5]],
    [
      "between",
      { id: { between: [5, 9] } },
      '"t0"."id" between $1 and $2',
      [5, 9],
    ],
    [
      "in",
      { status: { in: ["paid", "shipped"] } },
      '"t0"."status" in ($1, $2)',
      ["paid", "shipped"],
    ],
    [
      "notIn",
      { status: { notIn: ["paid", "shipped"] } },
      '"t0"."status" not in ($1, $2)',
      ["paid", "shipped"],
    ],
    ["isNull true", { notes: { isNull: true } }, '"t0"."notes" is null', []],
    [
      "isNull false",
      { notes: { isNull: false } },
      '"t0"."notes" is not null',
      [],
    ],
  ])("%s", (_name, filter, expected, parameters) => {
    expect(where(filter)).toEqual({
      sql: `${base}${expected}${tail(parameters.length)}`,
      parameters: [...parameters, 1001, 0],
    });
  });

  it("contains binds one escaped pattern for a case-insensitive match", () => {
    const c = where({ notes: { contains: "50%_off\\" } });
    expect(c.sql).toBe(
      `${base}"t0"."notes" ilike $1 escape '\\' order by "c0" asc nulls last limit $2 offset $3`
    );
    expect(c.parameters).toEqual(["%50\\%\\_off\\\\%", 1001, 0]);
  });

  it("startsWith anchors the escaped pattern at the start", () => {
    expect(where({ notes: { startsWith: "a_b" } }).parameters[0]).toBe(
      "a\\_b%"
    );
  });

  it("combines and, or and not with parentheses", () => {
    const c = where({
      and: [
        { status: { eq: "paid" } },
        { or: [{ id: { lt: 3 } }, { not: { notes: { isNull: true } } }] },
      ],
    });
    expect(c.sql).toBe(
      `${base}("t0"."status" = $1 and ("t0"."id" < $2 or not ("t0"."notes" is null)))${tail(2)}`
    );
    expect(c.parameters).toEqual(["paid", 3, 1001, 0]);
  });

  it("filters on a joined column", () => {
    expect(
      compile({
        join: ["customer"],
        where: { "customer.region": { eq: "emea" } },
      }).sql
    ).toContain('where "t1"."region" = $1');
  });

  it("casts a timestamp to timestamptz and leaves dates and integers bare", () => {
    expect(
      where({ created_at: { gte: "2026-01-01T00:00:00+02:00" } })
    ).toMatchObject({
      sql: expect.stringContaining(
        '"t0"."created_at" >= cast($1 as timestamptz)'
      ),
      parameters: ["2026-01-01T00:00:00+02:00", 1001, 0],
    });
    expect(
      where({ ordered_on: { between: ["2026-01-01", "2026-02-01"] } }).sql
    ).toContain('"t0"."ordered_on" between $1 and $2');
  });

  it("casts a decimal compared with a number column to numeric", () => {
    expect(where({ total: { in: [1, "2.50"] } }).sql).toContain(
      '"t0"."total" in ($1, cast($2 as numeric))'
    );
  });

  it("compares booleans as parameters", () => {
    const c = compile({
      from: "customers",
      select: ["id"],
      where: { vip: { eq: true } },
    });
    expect(c.sql).toContain('"t0"."vip" = $1');
    expect(c.parameters[0]).toBe(true);
  });
});
