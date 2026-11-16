import type { BucketUnit, PlanValue, ResolvedExpr } from "../types.js";
import type { SqlDialect, ValueSubject } from "../dialect.js";
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

/**
 * `[name]`, with `]` doubled; `[` needs no escaping inside brackets. A
 * parameter object met again (a select item's expression repeated in GROUP BY
 * or ORDER BY) takes its first placeholder, so SQL Server sees the same
 * expression in both places.
 */
class BracketQueryCompiler extends MssqlQueryCompiler {
  #placeholders = new Map<object, string>();

  override compileQuery(
    ...args: Parameters<MssqlQueryCompiler["compileQuery"]>
  ): ReturnType<MssqlQueryCompiler["compileQuery"]> {
    this.#placeholders = new Map();
    return super.compileQuery(...args);
  }

  protected override appendValue(parameter: unknown): void {
    if (typeof parameter !== "object" || parameter === null) {
      super.appendValue(parameter);
      return;
    }
    const seen = this.#placeholders.get(parameter);
    if (seen !== undefined) {
      this.append(seen);
      return;
    }
    super.appendValue(parameter);
    this.#placeholders.set(parameter, this.getCurrentParameterPlaceholder());
  }

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
const FLOATS = new Set(["float", "real"]);
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
/** How a number binds: bigint, a decimal of this scale, or float. */
const numberBinding = (
  text: string
): { kind: "bigint" | "float" } | { kind: "decimal"; scale: number } => {
  if (INTEGER_TEXT.test(text)) {
    const n = BigInt(text);
    if (n <= INT64_MAX && n >= -INT64_MAX - 1n) return { kind: "bigint" };
  }
  const m = DECIMAL_TEXT.exec(text);
  if (m) {
    const integerDigits = m[1]!.replace(/^0+/, "").length;
    const scale = m[2]?.length ?? 0;
    if (integerDigits + scale <= DECIMAL_MAX_DIGITS) {
      return { kind: "decimal", scale };
    }
  }
  return { kind: "float" };
};

const value = (
  v: PlanValue,
  { type, nativeType }: ValueSubject
): Expression<unknown> => {
  switch (type) {
    case "number": {
      const text = String(v);
      const binding = numberBinding(text);
      if (binding.kind === "bigint") return param("bigint", text);
      if (binding.kind === "decimal") {
        return sql`cast(${param("nvarchar", text)} as decimal(38, ${sql.lit(binding.scale)}))`;
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

type NumberKind = "integer" | "money" | "decimal" | "float";
/** SQL Server's precedence: arithmetic over two kinds yields the later. */
const KIND_ORDER: NumberKind[] = ["integer", "money", "decimal", "float"];

const kindOfType = (nativeType: string): NumberKind | undefined => {
  const base = baseType(nativeType);
  if (SMALL_INTEGERS.has(base) || base === "bigint") return "integer";
  if (DECIMALS.has(base)) return "decimal";
  if (MONEY.has(base)) return "money";
  if (FLOATS.has(base)) return "float";
  return undefined;
};

const widest = (kinds: (NumberKind | undefined)[]): NumberKind | undefined =>
  kinds.reduce<NumberKind | undefined>(
    (a, b) =>
      a === undefined || b === undefined
        ? (a ?? b)
        : KIND_ORDER[Math.max(KIND_ORDER.indexOf(a), KIND_ORDER.indexOf(b))],
    undefined
  );

/** What kind of number a calculation is on the server, as this dialect compiles it; undefined when it is not a number. */
const exprKind = (expr: ResolvedExpr): NumberKind | undefined => {
  switch (expr.kind) {
    case "column":
      return expr.column.type === "number"
        ? kindOfType(expr.column.nativeType)
        : undefined;
    case "literal": {
      if (expr.type === "text") return undefined;
      const { kind } = numberBinding(String(expr.value));
      return kind === "bigint" ? "integer" : kind;
    }
    case "aggregate": {
      if (expr.fn === "count" || expr.fn === "countDistinct") return "integer";
      if (expr.fn === "avg") return "float";
      if (expr.arg === "*" || expr.type !== "number") return undefined;
      if (expr.fn === "sum" && expr.arg.kind === "column") {
        // As `sumOf` sums it.
        const base = baseType(expr.arg.column.nativeType);
        if (base === "bigint") return "decimal";
        if (base === "real") return "float";
      }
      return exprKind(expr.arg);
    }
    case "op":
      if (expr.type !== "number") return undefined;
      if (expr.op === "div" || expr.op === "round") return "decimal";
      return widest(expr.args.map(exprKind));
  }
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
    case "calc": {
      if (item.type !== "number") return undefined;
      const kind = exprKind(item.expr);
      return kind === "decimal" || kind === "money" ? kind : undefined;
    }
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
  literal: (v, type) =>
    type === "text" ? param("nvarchar", String(v)) : value(v, { type }),
  // Lower-case, as Postgres prints a uuid.
  text: (expression, nativeType) =>
    baseType(nativeType) === "uniqueidentifier"
      ? sql`lower(cast(${expression} as nvarchar(36)))`
      : expression,
  isFloat: (nativeType) => FLOATS.has(baseType(nativeType)),
  // decimal(38, 18) / decimal(38, 10) keeps 8 places, truncated; rounded to
  // 6 they are the places a full quotient rounds to. Integers are cast, so
  // they never divide as integers.
  divide: (a, b) =>
    sql`cast(round(cast(${a} as decimal(38, 18)) / nullif(cast(${b} as decimal(38, 10)), 0), 6) as decimal(38, 6))`,
  // ROUND on a decimal goes half away from zero (on a float it would round
  // the binary value); the cast leaves exactly `places`.
  round: (a, places) =>
    sql`cast(round(cast(${a} as decimal(38, 10)), ${sql.lit(places)}) as decimal(38, ${sql.lit(places)}))`,
  // An exact number prints its own scale and no exponent; a float would
  // print in 6 significant digits or an exponent, so it goes through
  // decimal(38, 10) with trailing zeros (and a bare point) trimmed: spaces
  // stand in for zeros, then for the point, for RTRIM to take.
  numberToText: (a, approximate) =>
    approximate
      ? sql`replace(rtrim(replace(replace(rtrim(replace(cast(cast(${a} as decimal(38, 10)) as nvarchar(64)), '0', ' ')), ' ', '0'), '.', ' ')), ' ', '.')`
      : sql`cast(${a} as nvarchar(64))`,
  concat: (parts) => sql`concat(${sql.join(parts)})`,
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
