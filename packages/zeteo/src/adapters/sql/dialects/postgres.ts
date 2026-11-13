import type { SqlDialect, ValueSubject } from "../dialect.js";
import { postgresBaseType } from "../../postgres/types.js";
import type { PlanValue } from "../types.js";
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
const INT2 = 32_767n;
const INT4 = 2_147_483_647n;
const INT8 = 9_223_372_036_854_775_807n;
const NAIVE_TIMESTAMP = /^timestamp(\(\d+\))?( without time zone)?$/;

/** The largest magnitude an integer literal may have before the column's own integer type rejects it. */
const integerLimit = (nativeType: string | undefined): bigint => {
  if (nativeType === "smallint" || nativeType === "int2") return INT2;
  if (nativeType === "integer" || nativeType === "int" || nativeType === "int4")
    return INT4;
  return INT8;
};

/**
 * The server infers a bound parameter's type from the column it is compared
 * with, so most values need no cast. A domain is typed as its base type. The
 * exceptions:
 * - a decimal compared with an integer column or aggregate (`sum` of integers
 *   is bigint) would be read as an integer and fail, so it is cast to
 *   numeric, which compares with every numeric type;
 * - an integer literal outside the range of the column's integer type would
 *   raise "out of range" instead of matching nothing, so it is cast to
 *   numeric too; in range, integers stay uncast to keep indexes usable;
 * - a timestamp has an offset, which an inferred `timestamp without time
 *   zone` would silently drop. It is cast to timestamptz, and for a naive
 *   column converted to UTC (the session runs in UTC) on the parameter side,
 *   so the column is compared as it is and its index stays usable;
 * - text compared with a uuid column is cast to uuid, so the column is
 *   compared as it is and its index stays usable (a malformed uuid fails as
 *   the caller's value).
 * Dates infer as dates, text as text (an enum or money column is read as
 * text or numeric, see `column`), booleans as booleans.
 */
const value = (
  v: PlanValue,
  { type, nativeType }: ValueSubject
): Expression<unknown> => {
  const base = postgresBaseType(nativeType);
  if (type === "text" && base === "uuid") return sql`cast(${v} as uuid)`;
  if (type === "timestamp") {
    return NAIVE_TIMESTAMP.test(base)
      ? sql`(cast(${v} as timestamptz) at time zone 'UTC')`
      : sql`cast(${v} as timestamptz)`;
  }
  if (type === "number") {
    const text = String(v);
    const outOfRange = (() => {
      if (!INTEGER_TEXT.test(text)) return true;
      const n = BigInt(text);
      const limit = integerLimit(base);
      return n > limit || n < -limit - 1n;
    })();
    if (outOfRange) return sql`cast(${v} as numeric)`;
  }
  return sql`${v}`;
};

const ESCAPE = "\\";

/**
 * A column as every part of a query reads it. Money compares and sums only
 * with money, and prints with a currency symbol: it is read as numeric. An
 * enum compares only with its own labels (an unknown one is an error) and
 * sorts in declaration order: it is read as text. A uuid stays as it is, so
 * comparisons can use its index; `like` and `min`/`max` cast it themselves.
 */
const column = (
  expression: Expression<unknown>,
  nativeType: string
): Expression<unknown> => {
  switch (postgresBaseType(nativeType)) {
    case "money":
      return sql`cast(${expression} as numeric)`;
    case "enum":
      return sql`cast(${expression} as text)`;
    default:
      return expression;
  }
};

/** A uuid as text, for what uuid itself has no operator for (`ilike`, `min`, `max`). */
const asText = (
  expression: Expression<unknown>,
  nativeType: string | undefined
): Expression<unknown> =>
  postgresBaseType(nativeType) === "uuid"
    ? sql`cast(${expression} as text)`
    : expression;

export const postgresDialect: SqlDialect = {
  name: "postgres",
  // The protocol counts a statement's parameters in 16 bits.
  maxParameters: 65_535,
  column,
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
  like: (expression, pattern, nativeType): Expression<SqlBool> =>
    sql<SqlBool>`${asText(expression, nativeType)} ilike ${pattern} escape ${sql.lit(ESCAPE)}`,
  // Ordinals: a bucket's unit is a bound parameter, and repeating the
  // expression would number it twice, which the server rejects as two
  // different expressions.
  groupBy: (qb, items) =>
    qb.groupBy(items.map(({ index }) => sql.lit(index + 1))),
  // A select item is ordered by its alias: Postgres reads a bare output name
  // in ORDER BY as the output column before any input column of that name.
  orderBy: (qb, { expression, alias }, direction) =>
    qb.orderBy(alias ?? expression, (ob) =>
      direction === "asc" ? ob.asc().nullsLast() : ob.desc().nullsFirst()
    ),
  distinct: (qb) => qb.distinct(),
  aggregate: (fn, arg, nativeType) => {
    if (arg === "*") {
      if (fn !== "count") throw new Error(`${fn} cannot take *`);
      return sql`count(*)`;
    }
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
        return sql`min(${asText(arg, nativeType)})`;
      case "max":
        return sql`max(${asText(arg, nativeType)})`;
    }
  },
  output: (_item, expression) => expression,
  page: (qb, limit, offset) => qb.limit(limit).offset(offset),
};
