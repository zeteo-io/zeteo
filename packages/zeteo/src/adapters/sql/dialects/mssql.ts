import type { SqlDialect, ValueSubject } from "../dialect.js";
import type { BucketUnit, PlanValue } from "../types.js";
import {
  DummyDriver,
  Kysely,
  MssqlAdapter,
  MssqlIntrospector,
  MssqlQueryCompiler,
  sql,
  type Expression,
  type SqlBool,
} from "kysely";

/**
 * A bound value with the type it is declared as. SQL Server's driver needs
 * every parameter's type; it is chosen here, from the plan, never from the
 * JS value.
 */
export interface MssqlParameter {
  type: "nvarchar" | "bigint" | "bit" | "float";
  value: string | number | boolean;
}

const param = (
  type: MssqlParameter["type"],
  value: MssqlParameter["value"]
): Expression<unknown> => sql`${{ type, value } satisfies MssqlParameter}`;

/** `[name]`, with `]` doubled; `[` needs no escaping inside brackets. */
class BracketQueryCompiler extends MssqlQueryCompiler {
  protected override getLeftIdentifierWrapper(): string {
    return "[";
  }

  protected override getRightIdentifierWrapper(): string {
    return "]";
  }

  protected override sanitizeIdentifier(identifier: string): string {
    return identifier.replaceAll("]", "]]");
  }
}

/** A native type's name without its length, precision or scale. */
const baseType = (nativeType: string | undefined): string =>
  (nativeType ?? "").replace(/\(.*$/, "").trim().toLowerCase();

const SMALL_INTEGERS = new Set(["tinyint", "smallint", "int"]);
const DECIMALS = new Set(["decimal", "numeric"]);
const MONEY = new Set(["money", "smallmoney"]);
const NAIVE_TIMESTAMPS = new Set(["datetime", "datetime2", "smalldatetime"]);

const INT64_MAX = 9_223_372_036_854_775_807n;
const INTEGER_TEXT = /^-?\d+$/;
const DECIMAL_TEXT = /^-?(\d+)(?:\.(\d+))?$/;
const DECIMAL_MAX_DIGITS = 38;
/** A timestamp's fraction past its seventh digit, SQL Server's precision. */
const PAST_100_NS = /(\.\d{7})\d+/;
/** Large-object text SQL Server cannot sort, group or lower; read as nvarchar(max) instead. */
const LARGE_TEXT = new Set(["text", "ntext", "xml"]);

/**
 * Numbers: an integer in bigint's range binds as bigint, which compares with
 * every numeric type without an out-of-range error. A decimal binds as text
 * cast to a decimal of its own scale, so no digit goes through a float.
 * A number no decimal(38) holds (an exponent, or more digits) binds as float.
 *
 * Text binds as nvarchar, so no character is lost to a code page; dates and
 * timestamps bind as their ISO text, cast to their type, which SQL Server
 * reads the same whatever the session's language and date format. A
 * timestamp compared with a naive column (datetime2, datetime,
 * smalldatetime, read as UTC) is converted to UTC on the parameter side, so
 * the column is compared as it is and its index stays usable. For a
 * `datetime` column it becomes a `datetime`, rounded to the same 1/300 s tick
 * the column holds, so a value read from the column (rounded by the driver
 * to the millisecond) finds its row again; any other comparison happens in
 * `datetime2(7)`, where `smalldatetime`'s whole minutes compare exactly.
 * Fractions past 100 ns, which SQL Server would round (into the next day,
 * at worst), are cut first.
 */
const value = (
  v: PlanValue,
  { type, nativeType }: ValueSubject
): Expression<unknown> => {
  switch (type) {
    case "number": {
      const text = String(v);
      if (INTEGER_TEXT.test(text)) {
        const n = BigInt(text);
        if (n <= INT64_MAX && n >= -INT64_MAX - 1n)
          return param("bigint", text);
      }
      const m = DECIMAL_TEXT.exec(text);
      if (m) {
        const integerDigits = m[1]!.replace(/^0+/, "").length;
        const scale = m[2]?.length ?? 0;
        if (integerDigits + scale <= DECIMAL_MAX_DIGITS) {
          return sql`cast(${param("nvarchar", text)} as decimal(38, ${sql.lit(scale)}))`;
        }
      }
      return param("float", Number(text));
    }
    case "boolean":
      return param("bit", v);
    case "date":
      return sql`cast(${param("nvarchar", String(v))} as date)`;
    case "timestamp": {
      const text = String(v).replace(PAST_100_NS, "$1");
      const instant = sql`cast(${param("nvarchar", text)} as datetimeoffset)`;
      const base = baseType(nativeType);
      if (!NAIVE_TIMESTAMPS.has(base)) return instant;
      return base === "datetime"
        ? sql`cast(switchoffset(${instant}, '+00:00') as datetime)`
        : sql`cast(switchoffset(${instant}, '+00:00') as datetime2(7))`;
    }
    default:
      return param("nvarchar", String(v));
  }
};

// A closed map: the unit is written into the SQL as a keyword, so the bucket
// expression holds no parameter and can be repeated in GROUP BY and ORDER BY.
// `iso_week` starts on Monday whatever the session's DATEFIRST.
const DATEPART: Record<BucketUnit, string> = {
  day: "day",
  week: "iso_week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

/** The sum as SQL Server computes it without overflow or a float: bigint for small integers, decimal(38,0) for bigint. */
const sumOf = (arg: Expression<unknown>, nativeType: string | undefined) => {
  const base = baseType(nativeType);
  if (SMALL_INTEGERS.has(base)) return sql`sum(cast(${arg} as bigint))`;
  if (base === "bigint") return sql`sum(cast(${arg} as decimal(38,0)))`;
  // SQL Server sums a real in float; Postgres keeps it real.
  if (base === "real") return sql`cast(sum(${arg}) as real)`;
  return sql`sum(${arg})`;
};

const isExact = (nativeType: string | undefined) => {
  const base = baseType(nativeType);
  return (
    SMALL_INTEGERS.has(base) ||
    base === "bigint" ||
    DECIMALS.has(base) ||
    MONEY.has(base)
  );
};

/** What a select item's value is on the server: decimal, money or something the driver reads exactly. */
const exactKind = (
  item: Parameters<SqlDialect["output"]>[0]
): "decimal" | "money" | undefined => {
  const kindOf = (nativeType: string) => {
    const base = baseType(nativeType);
    if (DECIMALS.has(base)) return "decimal" as const;
    if (MONEY.has(base)) return "money" as const;
    return undefined;
  };
  switch (item.kind) {
    case "column":
      return kindOf(item.column.nativeType);
    case "bucket":
      return undefined;
    case "aggregate":
      if (item.column === "*") return undefined;
      if (item.fn === "min" || item.fn === "max") {
        return kindOf(item.column.nativeType);
      }
      if (item.fn === "sum") {
        return baseType(item.column.nativeType) === "bigint"
          ? "decimal"
          : kindOf(item.column.nativeType);
      }
      return undefined;
  }
};

const ESCAPE = "\\";

export const mssqlDialect: SqlDialect = {
  name: "mssql",
  // SQL Server takes 2,100 parameters per request; sp_executesql, which the
  // driver calls, uses two for the statement and its declarations.
  maxParameters: 2098,
  column: (expression, nativeType) =>
    LARGE_TEXT.has(baseType(nativeType))
      ? sql`cast(${expression} as nvarchar(max))`
      : expression,
  kysely: new Kysely<never>({
    dialect: {
      createAdapter: () => new MssqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MssqlIntrospector(db),
      createQueryCompiler: () => new BracketQueryCompiler(),
    },
  }),
  value,
  bucket: (unit, column, type, nativeType) => {
    const part = sql.raw(DATEPART[unit]);
    if (type === "date")
      return sql`cast(datetrunc(${part}, ${column}) as date)`;
    const utc =
      baseType(nativeType) === "datetimeoffset"
        ? sql`switchoffset(${column}, '+00:00')`
        : column;
    return sql`cast(datetrunc(${part}, ${utc}) as datetime2(3))`;
  },
  // LOWER on both sides makes the match case-insensitive whatever the
  // column's collation; `[` opens a character class in SQL Server's LIKE.
  like: (column, pattern): Expression<SqlBool> =>
    sql<SqlBool>`lower(${column}) like lower(${param(
      "nvarchar",
      pattern.replaceAll("[", `${ESCAPE}[`)
    )}) escape ${sql.lit(ESCAPE)}`,
  // Expressions, not ordinals, which SQL Server has none of in GROUP BY.
  groupBy: (qb, items) => qb.groupBy(items.map(({ expression }) => expression)),
  // Nulls last ascending and first descending by a leading CASE: SQL Server
  // sorts nulls lowest and has no NULLS LAST. An alias cannot be used inside
  // an expression in ORDER BY, so the expression is repeated.
  orderBy: (qb, { expression }, direction) =>
    direction === "asc"
      ? qb
          .orderBy(sql`case when ${expression} is null then 1 else 0 end`)
          .orderBy(expression, (ob) => ob.asc())
      : qb
          .orderBy(sql`case when ${expression} is null then 0 else 1 end`)
          .orderBy(expression, (ob) => ob.desc()),
  // DISTINCT would forbid ORDER BY anything not selected, the null-ordering
  // CASE included; grouping by every item returns the same rows and allows it.
  distinct: (qb, items, grouped) =>
    grouped ? qb : qb.groupBy(items.map(({ expression }) => expression)),
  aggregate: (fn, arg, nativeType) => {
    if (arg === "*") {
      if (fn !== "count") throw new Error(`${fn} cannot take *`);
      return sql`count_big(*)`;
    }
    switch (fn) {
      case "count":
        return sql`count_big(${arg})`;
      case "countDistinct":
        return sql`count_big(distinct ${arg})`;
      case "sum":
        return sumOf(arg, nativeType);
      // An exact column is summed exactly and divided once in float, as
      // Postgres's numeric average is rounded once to float8; averaging
      // floats would round at every addition.
      case "avg":
        return isExact(nativeType)
          ? sql`cast(${sumOf(arg, nativeType)} as float) / nullif(count_big(${arg}), 0)`
          : sql`avg(cast(${arg} as float))`;
      case "min":
        return sql`min(${arg})`;
      case "max":
        return sql`max(${arg})`;
    }
  },
  // The driver reads decimal and money as JS numbers, which lose digits past
  // 2^53 and the column's trailing zeros; as text they arrive as SQL Server
  // prints them, which is how Postgres prints the same decimal. Style 2 keeps
  // money's four decimal places.
  output: (item, expression) => {
    switch (exactKind(item)) {
      case "decimal":
        return sql`cast(${expression} as varchar(48))`;
      case "money":
        return sql`convert(varchar(48), ${expression}, 2)`;
      default:
        return expression;
    }
  },
  // OFFSET … FETCH needs an ORDER BY; with nothing to order by, one that
  // orders by nothing.
  page: (qb, limit, offset, ordered) =>
    (ordered ? qb : qb.orderBy(sql`(select null)`)).modifyEnd(
      sql`offset ${param("bigint", String(offset))} rows fetch next ${param("bigint", String(limit))} rows only`
    ),
};
