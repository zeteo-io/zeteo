import type { PlanValue, QueryableType } from "../types.js";
import type { SqlDialect } from "../dialect.js";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type Expression,
  type SqlBool,
} from "kysely";

const INTEGER_TEXT = /^-?\d+$/;

/**
 * The server infers a bound parameter's type from the column it is compared
 * with, so most values need no cast. Two do:
 * - a decimal compared with an integer column or aggregate (`sum` of integers
 *   is bigint) would be read as an integer and fail, so non-integers are cast
 *   to numeric, which compares with every numeric type; integers stay
 *   uncast to keep indexes usable;
 * - a timestamp with an offset compared with `timestamp without time zone`
 *   would silently lose its offset, so timestamps are cast to timestamptz;
 *   the session runs in UTC, which makes the comparison with a naive column
 *   mean UTC too.
 * Dates infer as dates, text as text, booleans as booleans.
 */
const value = (v: PlanValue, type: QueryableType): Expression<unknown> => {
  if (type === "timestamp") return sql`cast(${v} as timestamptz)`;
  if (type === "number" && !INTEGER_TEXT.test(String(v)))
    return sql`cast(${v} as numeric)`;
  return sql`${v}`;
};

const ESCAPE = "\\";

export const postgresDialect: SqlDialect = {
  name: "postgres",
  kysely: new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }),
  value,
  bucket: (unit, column, type) => {
    const truncated = sql`date_trunc(${unit}, ${column})`;
    return type === "date" ? sql`${truncated}::date` : truncated;
  },
  like: (column, pattern): Expression<SqlBool> =>
    sql<SqlBool>`${column} ilike ${pattern} escape ${sql.lit(ESCAPE)}`,
  orderBy: (qb, expression, direction) =>
    qb.orderBy(expression, (ob) =>
      direction === "asc" ? ob.asc().nullsLast() : ob.desc().nullsFirst()
    ),
  aggregate: (fn, arg) => {
    if (arg === "*") return sql`count(*)`;
    switch (fn) {
      case "count":
        return sql`count(${arg})`;
      case "countDistinct":
        return sql`count(distinct ${arg})`;
      case "sum":
        return sql`sum(${arg})`;
      case "avg":
        return sql`avg(${arg})::float8`;
      case "min":
        return sql`min(${arg})`;
      case "max":
        return sql`max(${arg})`;
    }
  },
  page: (qb, limit, offset) => qb.limit(limit).offset(offset),
};
