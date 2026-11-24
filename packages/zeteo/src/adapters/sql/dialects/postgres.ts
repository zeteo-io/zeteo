import { fiscalShift, SECONDS_IN, truncUnit } from "../dialect.js";
import type { SqlDialect, ValueSubject } from "../dialect.js";
import { postgresBaseType } from "../../postgres/types.js";
import { invalidValue } from "../../../engine/errors.js";
import type { DateAddUnit } from "../language.js";
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
const DECIMAL_TEXT = /^-?(\d+)(?:\.(\d+))?$/;
/** numeric's limits: digits before and after the point. */
const NUMERIC_INTEGER_DIGITS = 131_072;
const NUMERIC_SCALE = 16_383;
const FLOATS = new Set(["real", "double precision", "float4", "float8"]);

/** The largest magnitude an integer literal may have before the column's own integer type rejects it. */
const integerLimit = (nativeType: string | undefined): bigint => {
  if (nativeType === "smallint" || nativeType === "int2") return INT2;
  if (nativeType === "integer" || nativeType === "int" || nativeType === "int4")
    return INT4;
  return INT8;
};

/**
 * Refuses a number numeric cannot hold before the server sees it: the
 * server's out-of-range error (22003) is left to mean overflow in the query's
 * own arithmetic.
 */
const checkNumeric = (text: string): void => {
  const m = DECIMAL_TEXT.exec(text);
  if (
    m &&
    (m[1]!.replace(/^0+/, "").length > NUMERIC_INTEGER_DIGITS ||
      (m[2]?.length ?? 0) > NUMERIC_SCALE)
  ) {
    throw invalidValue();
  }
};

/** An integer literal fits bigint; anything else (a decimal, an exponent) is numeric. */
const isBigint = (text: string): boolean => {
  if (!INTEGER_TEXT.test(text)) return false;
  const n = BigInt(text);
  return n <= INT8 && n >= -INT8 - 1n;
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
    checkNumeric(text);
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

/**
 * `value`'s rules for a whole list, bound as one array. The server infers an
 * uncast array parameter's type from the column, as it infers a value's: text,
 * dates, booleans, a uuid, an enum (read as text) and integers that fit the
 * column's integer type. Otherwise numbers are a numeric array, timestamps a
 * timestamptz array, converted to UTC for a naive column.
 */
const inSet = (
  expression: Expression<unknown>,
  values: readonly PlanValue[],
  { type, nativeType }: ValueSubject,
  negate: boolean
): Expression<SqlBool> => {
  const base = postgresBaseType(nativeType);
  const list = values.map((v) => (typeof v === "boolean" ? v : String(v)));
  let array: Expression<unknown> = sql`${list}`;
  if (type === "timestamp") {
    const instants = sql`cast(${list} as timestamptz[])`;
    const v = sql.id("v");
    array = NAIVE_TIMESTAMP.test(base)
      ? sql`array(select ${v} at time zone 'UTC' from unnest(${instants}) as ${sql.id("u")}(${v}))`
      : instants;
  } else if (type === "number") {
    for (const text of list as string[]) checkNumeric(text);
    const limit = integerLimit(base);
    const fits = (list as string[]).every((text) => {
      if (!INTEGER_TEXT.test(text)) return false;
      const n = BigInt(text);
      return n <= limit && n >= -limit - 1n;
    });
    if (!fits) array = sql`cast(${list} as numeric[])`;
  }
  return negate
    ? sql<SqlBool>`${expression} <> all(${array})`
    : sql<SqlBool>`${expression} = any(${array})`;
};

const ESCAPE = "\\";

/** `n` units as an interval; the number and unit are the planner's, never user text. */
const intervalOf = (n: number, unit: DateAddUnit) =>
  sql.raw(
    unit === "quarter"
      ? `interval '${n * 3} months'`
      : unit === "year"
        ? `interval '${n * 12} months'`
        : `interval '${n} ${unit === "week" ? "weeks" : unit === "month" ? "months" : "days"}'`
  );

/** A whole number of months; the number is the planner's integer, never user text. */
const months = (n: number) => sql.raw(`interval '${n} months'`);

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
  inSet,
  bucket: (unit, date, fiscalStartMonth) => {
    const shift = fiscalShift(unit, fiscalStartMonth);
    return shift === 0
      ? sql`date_trunc(${truncUnit(unit)}, ${date})::date`
      : sql`(date_trunc(${truncUnit(unit)}, ${date} - ${months(shift)}) + ${months(shift)})::date`;
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
  // Every literal is cast: two bare parameters would leave the server no
  // type to pick an operator or function by.
  literal: (v, type) => {
    if (type === "text") return sql`cast(${v} as text)`;
    if (type === "date") return sql`cast(${v} as date)`;
    if (type === "timestamp") return sql`cast(${v} as timestamptz)`;
    checkNumeric(v);
    return isBigint(v) ? sql`cast(${v} as bigint)` : sql`cast(${v} as numeric)`;
  },
  // The amount and unit are validated, so they are written as an interval
  // literal. Postgres clamps a month step to the month's last day.
  dateAdd: (expression, amount, unit, type) => {
    const shifted = sql`${expression} + ${intervalOf(amount, unit)}`;
    return type === "date" ? sql`cast(${shifted} as date)` : shifted;
  },
  dateDiff: (unit, start, end, type) => {
    const s =
      type === "date"
        ? sql`cast(${start} as date)`
        : sql`cast(${start} as timestamp)`;
    const e =
      type === "date"
        ? sql`cast(${end} as date)`
        : sql`cast(${end} as timestamp)`;
    const days =
      type === "date"
        ? sql`(${e} - ${s})`
        : sql`cast(trunc(extract(epoch from (${e} - ${s})) / 86400) as integer)`;
    if (unit in SECONDS_IN) {
      const per = SECONDS_IN[unit as keyof typeof SECONDS_IN];
      return type === "date"
        ? sql`(cast(${e} - ${s} as bigint) * ${sql.lit(86400 / per)})`
        : sql`cast(trunc(extract(epoch from (${e} - ${s})) / ${sql.lit(per)}) as bigint)`;
    }
    if (unit === "day") return days;
    if (unit === "week") return sql`(${days} / 7)`;
    const field = (part: "year" | "month", x: Expression<unknown>) =>
      sql`cast(extract(${sql.raw(part)} from ${x}) as integer)`;
    const boundaries = sql`((${field("year", e)} - ${field("year", s)}) * 12 + ${field("month", e)} - ${field("month", s)})`;
    const shifted = sql`${s} + ${boundaries} * interval '1 month'`;
    const completed = sql`(case when ${boundaries} > 0 and ${shifted} > ${e} then ${boundaries} - 1 when ${boundaries} < 0 and ${shifted} < ${e} then ${boundaries} + 1 else ${boundaries} end)`;
    if (unit === "month") return completed;
    return sql`(${completed} / ${sql.lit(unit === "quarter" ? 3 : 12)})`;
  },
  datePart: (part, expression, fiscalStartMonth) => {
    const field = (name: string) =>
      sql`cast(extract(${sql.raw(name)} from ${expression}) as integer)`;
    switch (part) {
      case "year":
      case "quarter":
      case "month":
      case "day":
        return field(part);
      case "weekday":
        return field("isodow");
      case "fiscal_year":
        return fiscalStartMonth === 1
          ? field("year")
          : sql`(${field("year")} + case when ${field("month")} >= ${sql.lit(fiscalStartMonth)} then 1 else 0 end)`;
      case "fiscal_quarter":
        return sql`((${field("month")} - ${sql.lit(fiscalStartMonth)} + 12) % 12 / 3 + 1)`;
    }
  },
  // Unconstrained numeric keeps each value's own scale.
  typedNull: (approximate) =>
    approximate ? sql`cast(null as float8)` : sql`cast(null as numeric)`,
  // timestamptz is an instant, and the session runs in UTC.
  timestampUtc: (expression) => expression,
  stepFence: "offset",
  subqueryInAggregate: true,
  // A MATERIALIZED WITH query is computed separately from the query around
  // it (PostgreSQL 12 and later: the WITH queries chapter), so the caller's
  // conditions only ever see the rows it returns; as a plain derived table,
  // the rule's condition would be merged with theirs and run in order of
  // cost. The WITH query names the table with its schema, so `r` hides
  // nothing it reads.
  ruled: (table, rule) =>
    sql`(with ${sql.id("r")} as materialized (select * from ${table} where ${rule}) select * from ${sql.id("r")})`,
  anchorPlus: (days) => sql`(date '1900-01-01' + ${days})`,
  truncate: (n) => sql`cast(trunc(cast(${n} as numeric)) as int)`,
  // WIDTH_BUCKET binary-searches the sorted array (bound as one parameter):
  // the count of values at most the bound. Equality is the difference of
  // two such counts.
  countWhere: (values, op, bound) => {
    const sorted = [...values].sort((a, b) => a - b);
    const atMost = (x: Expression<unknown>) =>
      sql`width_bucket(${x}, cast(${sorted} as int[]))`;
    return op === "<="
      ? atMost(bound)
      : sql`(${atMost(bound)} - ${atMost(sql`${bound} - 1`)})`;
  },
  // Native conversion, the zone name bound: the calendar takes only `UTC`
  // and region names (with a "/"), which Postgres reads by their rules, never
  // as fixed-offset abbreviations. The session runs in UTC, so a timestamp
  // without a zone is a UTC instant. Outside the window SQL Server knows the
  // zone's offsets for, null, as there, so both engines answer alike.
  zoneDate: (timestamp, zone) => {
    const instant = sql`cast(${timestamp} as timestamptz)`;
    return sql`case when ${instant} >= cast(${zone.from} as timestamptz) and ${instant} < cast(${zone.to} as timestamptz) then cast(${instant} at time zone cast(${zone.name} as text) as date) end`;
  },
  text: asText,
  isFloat: (nativeType) => FLOATS.has(postgresBaseType(nativeType)),
  // The casts match SQL Server's, which keeps only 8 places of this quotient
  // and truncates them; rounding 8 or more places half away from zero to 6
  // gives the same digits.
  divide: (a, b) =>
    sql`round(cast(${a} as numeric(38, 18)) / nullif(cast(${b} as numeric(38, 10)), 0), 6)`,
  // numeric's round goes half away from zero and keeps exactly `places`.
  round: (a, places) =>
    sql`round(cast(${a} as numeric(38, 10)), ${sql.lit(places)})`,
  // numeric prints no exponent and its own scale; a float through numeric
  // has 15 significant digits, cut to 10 places with trailing zeros trimmed.
  numberToText: (a, approximate) =>
    approximate
      ? sql`rtrim(rtrim(cast(round(cast(${a} as numeric), 10) as text), '0'), '.')`
      : sql`cast(${a} as text)`,
  concat: (parts) => sql`concat(${sql.join(parts)})`,
  output: (_item, expression) => expression,
  page: (qb, limit, offset) => qb.limit(limit).offset(offset),
};
