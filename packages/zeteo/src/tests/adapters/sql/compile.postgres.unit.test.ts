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
  it("refuses * for any aggregate but count", () => {
    expect(() => postgresDialect.aggregate("sum", "*")).toThrow(
      "sum cannot take *"
    );
  });

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

  it("casts a decimal compared with an aggregate to numeric, keeping an in-range integer bare", () => {
    const sums = (value: number | string) =>
      compile({
        select: [{ sum: "quantity", as: "q" }],
        from: "order_lines",
        having: { q: { gt: value } },
      });
    const head =
      'select sum("t0"."quantity") as "c0" from "shop"."order_lines" as "t0" having sum("t0"."quantity") > ';
    expect(sums(10)).toEqual({
      sql: `${head}$1${tail(1)}`,
      parameters: [10, 1001, 0],
    });
    expect(sums("10.5")).toEqual({
      sql: `${head}cast($1 as numeric)${tail(1)}`,
      parameters: ["10.5", 1001, 0],
    });
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
      })
    ).toEqual({
      sql:
        'select "t0"."id" as "c0" from "shop"."orders" as "t0"' +
        ' inner join "shop"."customers" as "t1" on "t0"."customer_id" = "t1"."id"' +
        ` where "t1"."region" = $1${tail(1)}`,
      parameters: ["emea", 1001, 0],
    });
  });

  it("casts a timestamp to timestamptz for a timestamptz column", () => {
    expect(where({ created_at: { gte: "2026-01-01T00:00:00+02:00" } })).toEqual(
      {
        sql: `${base}"t0"."created_at" >= cast($1 as timestamptz)${tail(1)}`,
        parameters: ["2026-01-01T00:00:00+02:00", 1001, 0],
      }
    );
  });

  it.each(["timestamp without time zone", "timestamp(3) without time zone"])(
    "converts the timestamp to UTC on the parameter side for a %s column",
    (nativeType) => {
      const planned = planSql(
        sqlQuerySchema.parse({
          source: "shop",
          from: "orders",
          select: ["id"],
          where: { created_at: { gte: "2026-01-01T00:00:00+02:00" } },
        }),
        shopCatalog()
      );
      const filter = planned.where;
      if (filter?.kind !== "compare") throw new Error("expected a comparison");
      filter.subject.nativeType = nativeType;
      expect(
        compileSql(planned, postgresDialect, { limit: 1001, offset: 0 })
      ).toEqual({
        sql: `${base}"t0"."created_at" >= (cast($1 as timestamptz) at time zone 'UTC')${tail(1)}`,
        parameters: ["2026-01-01T00:00:00+02:00", 1001, 0],
      });
    }
  );

  it("leaves a date bare", () => {
    expect(
      where({ ordered_on: { between: ["2026-01-01", "2026-02-01"] } })
    ).toEqual({
      sql: `${base}"t0"."ordered_on" between $1 and $2${tail(2)}`,
      parameters: ["2026-01-01", "2026-02-01", 1001, 0],
    });
  });

  it("casts a decimal compared with a number column to numeric", () => {
    expect(where({ total: { in: [1, "2.50"] } })).toEqual({
      sql: `${base}"t0"."total" in ($1, cast($2 as numeric))${tail(2)}`,
      parameters: [1, "2.50", 1001, 0],
    });
  });

  it("casts an integer outside the column's own integer range to numeric", () => {
    // customer_id is a 4-byte integer, order id a bigint
    expect(
      where({ customer_id: { in: [2147483647, 2147483648, -2147483649] } })
    ).toEqual({
      sql: `${base}"t0"."customer_id" in ($1, cast($2 as numeric), cast($3 as numeric))${tail(3)}`,
      parameters: [2147483647, 2147483648, -2147483649, 1001, 0],
    });
    expect(where({ id: { in: [2147483648, "9223372036854775808"] } })).toEqual({
      sql: `${base}"t0"."id" in ($1, cast($2 as numeric))${tail(2)}`,
      parameters: [2147483648, "9223372036854775808", 1001, 0],
    });
  });

  it("compares booleans as parameters", () => {
    const c = compile({
      from: "customers",
      select: ["id"],
      where: { vip: { eq: true } },
    });
    expect(c).toEqual({
      sql: 'select "t0"."id" as "c0" from "shop"."customers" as "t0" where "t0"."vip" = $1 order by "c0" asc nulls last limit $2 offset $3',
      parameters: [true, 1001, 0],
    });
  });
});

describe("compileSql on Postgres: uuid, enum and money", () => {
  const ledger = (query: object) => compile({ from: "ledger", ...query });

  it("reads money as numeric wherever it is selected, aggregated, filtered or ordered", () => {
    expect(
      ledger({
        select: ["amount", { sum: "price", as: "s" }],
        where: { amount: { gt: "1.50" }, price: { between: [1, 2] } },
        groupBy: ["amount"],
        orderBy: [{ s: "desc" }],
      })
    ).toEqual({
      sql:
        'select cast("t0"."amount" as numeric) as "c0", sum(cast("t0"."price" as numeric)) as "c1"' +
        ' from "shop"."ledger" as "t0"' +
        ' where (cast("t0"."amount" as numeric) > cast($1 as numeric)' +
        ' and cast("t0"."price" as numeric) between $2 and $3)' +
        ' group by 1 order by "c1" desc nulls first limit $4 offset $5',
      parameters: ["1.50", 1, 2, 1001, 0],
    });
  });

  it("averages money as numeric, and orders by a money column that is not selected", () => {
    expect(ledger({ select: [{ avg: "amount", as: "a" }] }).sql).toBe(
      'select avg(cast("t0"."amount" as numeric))::float8 as "c0" from "shop"."ledger" as "t0"' +
        ORDERED
    );
    expect(ledger({ orderBy: [{ price: "asc" }] }).sql).toBe(
      'select "t0"."id" as "c0" from "shop"."ledger" as "t0"' +
        ' order by cast("t0"."price" as numeric) asc nulls last limit $1 offset $2'
    );
  });

  it("reads an enum, and a domain over one, as text wherever it is used", () => {
    expect(
      ledger({
        select: ["mood", { max: "feeling", as: "m" }],
        where: {
          mood: { in: ["happy", "nope"] },
          feeling: { contains: "ap" },
        },
        groupBy: ["mood"],
      })
    ).toEqual({
      sql:
        'select cast("t0"."mood" as text) as "c0", max(cast("t0"."feeling" as text)) as "c1"' +
        ' from "shop"."ledger" as "t0"' +
        ' where (cast("t0"."mood" as text) in ($1, $2)' +
        ` and cast("t0"."feeling" as text) ilike $3 escape '\\')` +
        ' group by 1 order by "c0" asc nulls last, "c1" asc nulls last limit $4 offset $5',
      parameters: ["happy", "nope", "%ap%", 1001, 0],
    });
  });

  it("compares a uuid as it is, with the value cast to uuid", () => {
    expect(
      ledger({
        select: ["ref"],
        where: {
          ref: { eq: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" },
          token: { notIn: ["a", "b"] },
        },
      })
    ).toEqual({
      sql:
        'select "t0"."ref" as "c0" from "shop"."ledger" as "t0"' +
        ' where ("t0"."ref" = cast($1 as uuid)' +
        ' and "t0"."token" not in (cast($2 as uuid), cast($3 as uuid)))' +
        tail(3),
      parameters: ["6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "a", "b", 1001, 0],
    });
  });

  it("matches and takes min or max of a uuid as text", () => {
    expect(
      ledger({
        select: [
          { min: "ref", as: "lo" },
          { max: "token", as: "hi" },
        ],
        where: { ref: { startsWith: "6F1C" }, token: { contains: "8a9b" } },
      }).sql
    ).toBe(
      'select min(cast("t0"."ref" as text)) as "c0", max(cast("t0"."token" as text)) as "c1"' +
        ' from "shop"."ledger" as "t0"' +
        ` where (cast("t0"."ref" as text) ilike $1 escape '\\'` +
        ` and cast("t0"."token" as text) ilike $2 escape '\\')` +
        ' order by "c0" asc nulls last, "c1" asc nulls last limit $3 offset $4'
    );
  });
});

describe("compileSql on Postgres: the parameter limit", () => {
  const lists = (count: number, extra: number) => ({
    or: [
      ...Array.from({ length: count }, (_, j) => ({
        id: { in: Array.from({ length: 1000 }, (_, i) => j * 1000 + i) },
      })),
      { id: { in: Array.from({ length: extra }, (_, i) => -1 - i) } },
    ],
  });

  it("binds 65,535 parameters, paging included", () => {
    expect(compile({ where: lists(65, 533) }).parameters).toHaveLength(65_535);
  });

  it("refuses a query that binds more with too_many_parameters, naming the limit", () => {
    expect(() => compile({ where: lists(65, 534) })).toThrow(
      expect.objectContaining({
        code: "too_many_parameters",
        statusCode: 422,
        path: [],
        message:
          "The query binds 65536 values; this source takes at most 65535 in one query, paging included",
      })
    );
  });
});

describe("compileSql on Postgres: without the default order", () => {
  const unordered = (query: object, fetch = { limit: 1001, offset: 0 }) =>
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
      { ...fetch, defaultOrder: false }
    );

  it("emits no order for a query with no orderBy, keeping the limit, the offset and every parameter", () => {
    expect(
      unordered(
        {
          select: ["id", "status"],
          where: { status: { eq: "paid" } },
        },
        { limit: 11, offset: 20 }
      )
    ).toEqual({
      sql:
        'select "t0"."id" as "c0", "t0"."status" as "c1" from "shop"."orders" as "t0"' +
        ' where "t0"."status" = $1 limit $2 offset $3',
      parameters: ["paid", 11, 20],
    });
  });

  it("emits no order for a distinct or grouped query with no orderBy", () => {
    expect(unordered({ select: ["status"], distinct: true }).sql).toBe(
      'select distinct "t0"."status" as "c0" from "shop"."orders" as "t0"' +
        " limit $1 offset $2"
    );
    expect(
      unordered({
        select: [
          "status",
          { bucket: "month", column: "created_at", as: "month" },
          { count: "*", as: "n" },
        ],
        groupBy: ["status", "month"],
      })
    ).toEqual({
      sql:
        'select "t0"."status" as "c0", date_trunc($1, "t0"."created_at") as "c1",' +
        ' count(*) as "c2" from "shop"."orders" as "t0"' +
        " group by 1, 2 limit $2 offset $3",
      parameters: ["month", 1001, 0],
    });
  });

  it("compiles a query with its own orderBy exactly as with the default order", () => {
    const queries = [
      { select: ["id", "total"], orderBy: [{ total: "desc" }, { id: "asc" }] },
      { orderBy: [{ notes: "desc" }] },
      { select: ["id", "status"], orderBy: [{ status: "asc" }] },
      {
        select: ["status", { sum: "total", as: "revenue" }],
        groupBy: ["status"],
        orderBy: [{ revenue: "desc" }],
      },
    ];
    for (const query of queries) {
      expect(unordered(query, { limit: 11, offset: 20 })).toEqual(
        compile(query, { limit: 11, offset: 20 })
      );
    }
  });

  it("keeps an orderBy of the query's own that equals the default order", () => {
    const query = { orderBy: [{ id: "asc" }] };
    expect(unordered(query)).toEqual(compile(query));
    expect(unordered(query).sql).toBe(
      'select "t0"."id" as "c0" from "shop"."orders" as "t0"' + ORDERED
    );
  });

  it("orders by every select item when defaultOrder is true or unset", () => {
    const query = { select: ["id", "status"] };
    const today = compile(query);
    expect(today.sql).toContain(
      ' order by "c0" asc nulls last, "c1" asc nulls last'
    );
    expect(
      compileSql(
        planSql(
          sqlQuerySchema.parse({ source: "shop", from: "orders", ...query }),
          shopCatalog()
        ),
        postgresDialect,
        { limit: 1001, offset: 0, defaultOrder: true }
      )
    ).toEqual(today);
  });
});
