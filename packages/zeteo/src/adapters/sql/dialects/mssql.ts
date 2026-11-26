import type { EqualityValues, SqlDialect, ValueSubject } from "../dialect.js";
import type { BucketUnit, PlanValue, ResolvedExpr } from "../types.js";
import { fiscalShift, SECONDS_IN } from "../dialect.js";
import { plainNumber } from "../values.js";
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
  type:
    "nvarchar" | "bigint" | "int" | "smallint" | "tinyint" | "bit" | "float";
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

const NAIVE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** A naive UTC instant from the planner (`YYYY-MM-DDTHH:MM:SS`) as a literal. */
const instantLit = (instant: string): Expression<unknown> => {
  if (!NAIVE_INSTANT.test(instant)) throw new Error("not a naive instant");
  return sql.lit(instant);
};

/**
 * How deep a search's CASE tree splits before a ladder takes over: SQL
 * Server nests CASE at most 10 deep, and a search is one or two levels more
 * than this (the ladder, an equality or a guard around it).
 */
const SEARCH_DEPTH = 7;

/**
 * `at(i)` for the i of the ascending `keys` at most `x`, found by a CASE
 * tree of comparisons, so a row compares `x` with a few keys and not all of
 * them. The keys are the planner's numbers, written as literals by `key`.
 * `x` must be a plain column (a fenced step's value): an inline expression
 * holding a CASE would add to the nesting and could pass SQL Server's limit
 * of 10. A null `x` falls through to the last branch, not 0: callers rely on
 * their own result being null when `x` is.
 */
const search = (
  x: Expression<unknown>,
  keys: readonly Expression<unknown>[],
  at: (i: number) => Expression<unknown>
): Expression<unknown> => {
  // Between lo and hi of the keys are at most x.
  const within = (
    lo: number,
    hi: number,
    depth: number
  ): Expression<unknown> => {
    if (lo === hi) return at(lo);
    if (depth === SEARCH_DEPTH) {
      const steps = [];
      for (let i = lo; i < hi; i++) {
        steps.push(sql`when ${x} < ${keys[i]!} then ${at(i)}`);
      }
      return sql`case ${sql.join(steps, sql` `)} else ${at(hi)} end`;
    }
    const mid = (lo + hi + 1) >> 1;
    return sql`case when ${x} < ${keys[mid - 1]!} then ${within(lo, mid - 1, depth + 1)} else ${within(mid, hi, depth + 1)} end`;
  };
  return within(0, keys.length, 0);
};

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

/** The range of each integer type. */
const INTEGER_RANGES: Record<string, readonly [bigint, bigint]> = {
  tinyint: [0n, 255n],
  smallint: [-32_768n, 32_767n],
  int: [-2_147_483_648n, 2_147_483_647n],
  bigint: [-INT64_MAX - 1n, INT64_MAX],
};
const DECIMAL_SIZE = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/;

/**
 * The exact numbers a column holds: at most `integerDigits` digits before
 * the point and `scale` after it, within `range` for an integer type.
 * Undefined for a float, or when the type is not known (an aggregate).
 */
interface ExactColumn {
  integerDigits: number;
  scale: number;
  range?: readonly [bigint, bigint];
}

const exactColumn = (
  nativeType: string | undefined
): ExactColumn | undefined => {
  const base = baseType(nativeType);
  const range = INTEGER_RANGES[base];
  if (range) {
    return { integerDigits: String(range[1]).length, scale: 0, range };
  }
  if (DECIMALS.has(base)) {
    // SQL Server's default is decimal(18, 0).
    const m = DECIMAL_SIZE.exec(nativeType ?? "");
    const precision = m ? Number(m[1]) : 18;
    const scale = m?.[2] === undefined ? 0 : Number(m[2]);
    return { integerDigits: precision - scale, scale };
  }
  if (base === "money") return { integerDigits: 15, scale: 4 };
  if (base === "smallmoney") return { integerDigits: 6, scale: 4 };
  return undefined;
};

/**
 * A number as exact decimal text, without an exponent, leading zeros or
 * trailing fraction zeros, or undefined when it holds more digits than
 * `column` can: no value of the column can equal it.
 */
const exactIn = (v: PlanValue, column: ExactColumn): string | undefined => {
  const text = typeof v === "number" ? plainNumber(v) : String(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return undefined;
  const whole = m[2]!.replace(/^0+/, "");
  const fraction = (m[3] ?? "").replace(/0+$/, "");
  if (whole.length > column.integerDigits || fraction.length > column.scale) {
    return undefined;
  }
  const sign = whole === "" && fraction === "" ? "" : m[1]!;
  const exact = `${sign}${whole || "0"}${fraction ? `.${fraction}` : ""}`;
  if (column.range) {
    const n = BigInt(exact);
    if (n < column.range[0] || n > column.range[1]) return undefined;
  }
  return exact;
};

/** What any of SQL Server's exact numbers can hold: decimal(38, s). */
const WIDEST: ExactColumn = {
  integerDigits: DECIMAL_MAX_DIGITS,
  scale: DECIMAL_MAX_DIGITS,
};

/**
 * A number as exact text, as `exactIn` writes it, when some exact number
 * type holds it: 38 digits at most in all. A column of any exact type, however
 * widened, holds no other.
 */
const exactWide = (v: PlanValue): string | undefined => {
  const exact = exactIn(v, WIDEST);
  if (exact === undefined) return undefined;
  const [whole, fraction = ""] = exact.replace(/^-/, "").split(".");
  const digits = whole!.replace(/^0+/, "").length + fraction.length;
  return digits <= DECIMAL_MAX_DIGITS ? exact : undefined;
};

/** An exact text's scale: its digits after the point. */
const scaleOf = (exact: string) => exact.split(".")[1]?.length ?? 0;

/**
 * An equality's values (`eq`, `ne`, `in`, `notIn`) against an integer,
 * decimal or money column: `held`, those the catalogue's type holds, as
 * exact text; `wider`, those with more digits than it holds or past an
 * integer type's range that some exact number still holds (bound as bigint
 * or decimal(38, s) by `value`, so compared exactly with a widened column);
 * and whether any has more than 38 digits, which none holds. A float column,
 * or an aggregate, holds every value. No value is compared through a float.
 */
const equalityValues = (
  values: readonly PlanValue[],
  { type, nativeType }: ValueSubject
): EqualityValues => {
  const column = type === "number" ? exactColumn(nativeType) : undefined;
  if (!column) return { held: [...values], wider: [], unbound: false };
  const held: PlanValue[] = [];
  const wider: PlanValue[] = [];
  let unbound = false;
  for (const v of values) {
    const exact = exactIn(v, column);
    if (exact !== undefined) {
      held.push(exact);
      continue;
    }
    const wide = exactWide(v);
    if (wide === undefined) unbound = true;
    else wider.push(wide);
  }
  return { held, wider, unbound };
};

/**
 * What a list of numbers is read as from JSON text: bigint when each binds as
 * bigint, else a decimal with the list's widest scale when one holds every
 * value, else float, as `value` binds one number.
 */
const numberListType = (texts: readonly string[]): Expression<unknown> => {
  let integerDigits = 0;
  let scale = 0;
  let decimal = true;
  let bigint = true;
  for (const text of texts) {
    const binding = numberBinding(text);
    if (binding.kind !== "bigint") bigint = false;
    const m = DECIMAL_TEXT.exec(text);
    if (!m) {
      decimal = false;
      continue;
    }
    integerDigits = Math.max(integerDigits, m[1]!.replace(/^0+/, "").length);
    scale = Math.max(scale, m[2]?.length ?? 0);
  }
  if (bigint) return sql`bigint`;
  return decimal && integerDigits + scale <= DECIMAL_MAX_DIGITS
    ? sql`decimal(38, ${sql.lit(scale)})`
    : sql`float`;
};

/**
 * `value`'s rules for a whole list, bound as one nvarchar parameter holding a
 * JSON array of text and read back with `openjson`, so a list of thousands
 * takes one of the request's 2,100 parameters. `openjson`'s value keeps the
 * parameter's collation (the database's default, as any bound nvarchar
 * has), and the cast to nvarchar(max) keeps its input's, so text compares
 * as a single bound value would. A subquery: never inside an aggregate or a
 * GROUP BY expression, which SQL Server refuses.
 */
const inSet = (
  expression: Expression<unknown>,
  values: readonly PlanValue[],
  { type, nativeType }: ValueSubject,
  negate: boolean
): Expression<SqlBool> => {
  const item = sql.id("value");
  let texts = values.map(String);
  let read: Expression<unknown>;
  switch (type) {
    case "number": {
      // An integer or decimal column reads the list in its own exact type,
      // never as a float, where neighbouring integers past 2^53 are one.
      const column = exactColumn(nativeType);
      if (!column) {
        read = sql`cast(${item} as ${numberListType(texts)})`;
        break;
      }
      // Values the column's type holds are read in that type; others
      // (`equalityValues`' wider ones) in a list per scale, as decimal(38, s),
      // each exactly.
      const held: string[] = [];
      const wider = new Map<number, string[]>();
      for (const v of values) {
        const exact = exactIn(v, column);
        if (exact !== undefined) {
          held.push(exact);
          continue;
        }
        const wide = exactWide(v);
        if (wide === undefined) {
          throw new Error("inSet takes no value that no exact number holds");
        }
        const scale = scaleOf(wide);
        wider.set(scale, [...(wider.get(scale) ?? []), wide]);
      }
      const lists: [string[], Expression<unknown>][] = [];
      if (held.length > 0) {
        lists.push([
          held,
          column.scale === 0 && column.range
            ? sql`cast(${item} as bigint)`
            : sql`cast(${item} as decimal(38, ${sql.lit(column.scale)}))`,
        ]);
      }
      for (const scale of [...wider.keys()].sort((a, b) => a - b)) {
        lists.push([
          wider.get(scale)!,
          sql`cast(${item} as decimal(38, ${sql.lit(scale)}))`,
        ]);
      }
      if (lists.length === 0) {
        // No value: `in` holds for no row, `notIn` for every row whose value
        // is not null, as the whole list would.
        return negate
          ? sql<SqlBool>`${expression} = ${expression}`
          : sql<SqlBool>`${expression} <> ${expression}`;
      }
      const parts = lists.map(([list, as]) => {
        const set = sql`(select ${as} from openjson(${param("nvarchar", JSON.stringify(list))}))`;
        return negate
          ? sql<SqlBool>`${expression} not in ${set}`
          : sql<SqlBool>`${expression} in ${set}`;
      });
      return parts.length === 1
        ? parts[0]!
        : sql<SqlBool>`(${sql.join(parts, negate ? sql` and ` : sql` or `)})`;
    }
    case "boolean":
      texts = values.map((v) => (v === true ? "1" : "0"));
      read = sql`cast(${item} as bit)`;
      break;
    case "date":
      read = sql`cast(${item} as date)`;
      break;
    case "timestamp": {
      texts = texts.map((t) => t.replace(PAST_100_NS, "$1"));
      const instant = sql`cast(${item} as datetimeoffset)`;
      const base = baseType(nativeType);
      read = !NAIVE_TIMESTAMPS.has(base)
        ? instant
        : base === "datetime"
          ? sql`cast(switchoffset(${instant}, '+00:00') as datetime)`
          : sql`cast(switchoffset(${instant}, '+00:00') as datetime2(7))`;
      break;
    }
    default:
      read = sql`cast(${item} as nvarchar(max))`;
  }
  const list = sql`(select ${read} from openjson(${param("nvarchar", JSON.stringify(texts))}))`;
  return negate
    ? sql<SqlBool>`${expression} not in ${list}`
    : sql<SqlBool>`${expression} in ${list}`;
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
  fiscal_quarter: "quarter",
  fiscal_year: "year",
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
      if (expr.type !== "number") return undefined;
      const { kind } = numberBinding(
        typeof expr.value === "number" ? plainNumber(expr.value) : expr.value
      );
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
      const kind = exprKind(expr.arg);
      // An integer expression is summed in decimal(38, 0), see `aggregate`.
      return expr.fn === "sum" && kind === "integer" ? "decimal" : kind;
    }
    case "case":
      return expr.type !== "number"
        ? undefined
        : widest(
            [...expr.branches.map((b) => b.then), expr.otherwise].flatMap(
              (e) => (e ? [exprKind(e)] : [])
            )
          );
    case "dateAdd":
      return undefined;
    case "dateDiff":
    case "datePart":
    case "businessDays":
    case "businessPeriod":
      return "integer";
    case "addBusinessDays":
      return undefined;
    case "scalar":
      return exprKind(expr.plan.expr);
    case "pivot":
      return exprKind(expr.of);
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

// LOWER on both sides makes the match case-insensitive whatever the column's
// collation; `[` opens a character class in SQL Server's LIKE.
const like = (
  column: Expression<unknown>,
  pattern: string
): Expression<SqlBool> =>
  sql<SqlBool>`lower(${column}) like lower(${param(
    "nvarchar",
    pattern.replaceAll("[", `${ESCAPE}[`)
  )}) escape ${sql.lit(ESCAPE)}`;

/** nvarchar of any length: what text binds as, so a value of it is the column's own type. */
const OWN_TEXT = /^nvarchar\((\d+|max)\)$/;
const OWN_FRACTIONAL = /^(datetime2|datetimeoffset)\((\d)\)$/;
const PLAN_TIMESTAMP =
  /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * `value` bound as exactly the column's own type, or undefined. Each binding
 * is a typed parameter of that type, or a cast of a parameter to it whose
 * value the cast holds exactly, so no column value is converted and the
 * value cannot fail to convert:
 * - an integer in the range of an integer column, as a parameter of that type;
 * - a decimal (no exponent) whose digits a decimal or numeric column holds,
 *   cast from its text to exactly that type: SQL Server compares decimals
 *   exactly whatever their scale, so as `value`'s decimal(38, s) does;
 * - text against nvarchar of any length: the value takes the column's
 *   collation, an implicit one outranking a parameter's default;
 * - a date; a timestamp within years 1754 to 9998 at an offset SQL Server
 *   takes (±14:00), against datetimeoffset, datetime2 or datetime, with no
 *   more fractional digits than the column keeps, so nothing rounds;
 * - a boolean against bit.
 * Left out: float and real (a decimal compared with them converts one of the
 * two to a float), money, varchar, char and nchar (converted to nvarchar),
 * uniqueidentifier (its text converted), smalldatetime, and large-object text.
 */
const ownValue = (
  v: PlanValue,
  { type, nativeType }: { type: ValueSubject["type"]; nativeType: string }
): Expression<unknown> | undefined => {
  const base = baseType(nativeType);
  switch (type) {
    case "number": {
      if (typeof v === "boolean") return undefined;
      const text = String(v);
      const range = INTEGER_RANGES[base];
      if (range) {
        if (!INTEGER_TEXT.test(text)) return undefined;
        const n = BigInt(text);
        if (n < range[0] || n > range[1]) return undefined;
        return base === "bigint"
          ? param("bigint", text)
          : param(base as "int" | "smallint" | "tinyint", Number(text));
      }
      if (!DECIMALS.has(base) || !DECIMAL_TEXT.test(text)) return undefined;
      const column = exactColumn(nativeType);
      const exact = column && exactIn(text, column);
      if (exact === undefined) return undefined;
      const size = DECIMAL_SIZE.exec(nativeType);
      if (!size) return undefined;
      return sql`cast(${param("nvarchar", exact)} as ${sql.raw(base)}(${sql.lit(Number(size[1]))}, ${sql.lit(Number(size[2] ?? 0))}))`;
    }
    case "text":
      return typeof v === "string" && OWN_TEXT.test(nativeType)
        ? param("nvarchar", v)
        : undefined;
    case "boolean":
      return typeof v === "boolean" && base === "bit"
        ? param("bit", v)
        : undefined;
    case "date":
      return typeof v === "string" &&
        base === "date" &&
        /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? value(v, { type, nativeType })
        : undefined;
    case "timestamp": {
      const m = typeof v === "string" ? PLAN_TIMESTAMP.exec(v) : null;
      if (!m) return undefined;
      const year = Number(m[1]);
      const fraction = (m[2] ?? "").replace(/0+$/, "").length;
      if (year < 1754 || year > 9998) return undefined;
      if (m[3] !== undefined && Number(m[3]) * 60 + Number(m[4]) > 14 * 60) {
        return undefined;
      }
      if (base === "datetime") return value(v, { type, nativeType });
      const own = OWN_FRACTIONAL.exec(nativeType);
      if (!own || fraction > Number(own[2])) return undefined;
      const precise = Number(own[2]) === 7;
      if (own[1] === "datetimeoffset") {
        return precise
          ? value(v, { type, nativeType })
          : sql`cast(${param("nvarchar", String(v))} as datetimeoffset(${sql.lit(Number(own[2]))}))`;
      }
      return precise
        ? value(v, { type, nativeType })
        : sql`cast(switchoffset(cast(${param("nvarchar", String(v))} as datetimeoffset), '+00:00') as datetime2(${sql.lit(Number(own[2]))}))`;
    }
    default:
      return undefined;
  }
};

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
  equalityValues,
  inSet,
  bucket: (unit, date, fiscalStartMonth) => {
    const part = sql.raw(DATEPART[unit]);
    const shift = fiscalShift(unit, fiscalStartMonth);
    // The shift is the planner's integer, so it is written as a literal.
    const truncated =
      shift === 0
        ? sql`datetrunc(${part}, ${date})`
        : sql`dateadd(month, ${sql.lit(shift)}, datetrunc(${part}, dateadd(month, ${sql.lit(-shift)}, ${date})))`;
    return sql`cast(${truncated} as date)`;
  },
  like,
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
  aggregate: (fn, arg, nativeType, expr) => {
    if (arg === "*") {
      if (fn !== "count") throw new Error(`${fn} cannot take *`);
      return sql`count_big(*)`;
    }
    switch (fn) {
      case "count":
        return sql`count_big(${arg})`;
      case "countDistinct":
        return sql`count_big(distinct ${arg})`;
      // An integer expression would sum in its own int or bigint and
      // overflow where Postgres's sum (bigint, numeric) does not.
      case "sum":
        return expr !== undefined && exprKind(expr) === "integer"
          ? sql`sum(cast(${arg} as decimal(38, 0)))`
          : sumOf(arg, nativeType);
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
  // A decimal literal is cast to no more precision than its digits: SQL
  // Server sizes a product's precision from its operands', and a chain at
  // decimal(38, s) would cut the result to 6 places.
  literal: (v, type) => {
    if (type === "text") return param("nvarchar", v);
    // A timestamp literal is read as the naive UTC datetime2 a column holds.
    if (type === "date" || type === "timestamp") {
      return value(v, { type, nativeType: "datetime2" });
    }
    const binding = numberBinding(v);
    if (binding.kind !== "decimal") return value(v, { type });
    const digits = DECIMAL_TEXT.exec(v)![1]!.replace(/^0+/, "").length;
    return sql`cast(${param("nvarchar", v)} as decimal(${sql.lit(Math.max(digits + binding.scale, 1))}, ${sql.lit(binding.scale)}))`;
  },
  // The unit is a keyword and the amount a validated integer, both written
  // into the SQL. DATEADD clamps a month step to the month's last day.
  dateAdd: (expression, amount, unit) =>
    sql`dateadd(${sql.raw(unit)}, ${sql.lit(amount)}, ${expression})`,
  // DATEDIFF counts boundaries crossed, which is not whole units completed:
  // days of a timestamp come from microseconds, and months are corrected
  // against the clamped DATEADD, as Postgres's are.
  dateDiff: (unit, start, end, type) => {
    const read = (x: Expression<unknown>) =>
      type === "date"
        ? sql`cast(${x} as date)`
        : sql`cast(${x} as datetime2(7))`;
    const s = read(start);
    const e = read(end);
    const days =
      type === "date"
        ? sql`datediff(day, ${s}, ${e})`
        : sql`cast(datediff_big(microsecond, ${s}, ${e}) / cast(86400000000 as bigint) as int)`;
    if (unit in SECONDS_IN) {
      const per = SECONDS_IN[unit as keyof typeof SECONDS_IN];
      // Integer division truncates toward zero, as Postgres's trunc does.
      return type === "date"
        ? sql`(cast(datediff(day, ${s}, ${e}) as bigint) * ${sql.lit(86400 / per)})`
        : sql`(datediff_big(microsecond, ${s}, ${e}) / cast(${sql.lit(per * 1_000_000)} as bigint))`;
    }
    if (unit === "day") return days;
    if (unit === "week") return sql`(${days} / 7)`;
    const boundaries = sql`datediff(month, ${s}, ${e})`;
    const shifted = sql`dateadd(month, ${boundaries}, ${s})`;
    const completed = sql`(case when ${boundaries} > 0 and ${shifted} > ${e} then ${boundaries} - 1 when ${boundaries} < 0 and ${shifted} < ${e} then ${boundaries} + 1 else ${boundaries} end)`;
    if (unit === "month") return completed;
    return sql`(${completed} / ${sql.lit(unit === "quarter" ? 3 : 12)})`;
  },
  datePart: (part, expression, fiscalStartMonth) => {
    const field = (name: string) =>
      sql`datepart(${sql.raw(name)}, ${expression})`;
    switch (part) {
      case "year":
      case "quarter":
      case "month":
      case "day":
        return field(part);
      // Monday is 1 whatever the session's DATEFIRST.
      case "weekday":
        return sql`((${field("weekday")} + @@datefirst + 5) % 7 + 1)`;
      case "fiscal_year":
        return fiscalStartMonth === 1
          ? field("year")
          : sql`(${field("year")} + case when ${field("month")} >= ${sql.lit(fiscalStartMonth)} then 1 else 0 end)`;
      case "fiscal_quarter":
        return sql`((${field("month")} - ${sql.lit(fiscalStartMonth)} + 12) % 12 / 3 + 1)`;
    }
  },
  // A datetimeoffset keeps its own offset; date parts and differences are
  // taken on the UTC wall clock, or on the calendar zone's, read first.
  stepFence: "aggregate",
  subqueryInAggregate: false,
  // SQL Server may evaluate any condition or expression of a statement on a
  // row before another condition drops it, through a derived table, a CTE or
  // a CASE alike; only the order of statements is kept. So the rule's rows
  // are copied by a statement of their own into a temp table, which the
  // query reads: no expression of the caller's is in that statement, and the
  // query never reads the table itself. Any user may create temp tables, on a
  // read-only replica too; one created inside the request's sp_executesql is
  // dropped when it ends, and `drop table if exists` clears one a batch
  // without parameters left on the connection.
  //
  // Only the columns the query reads are copied (a constant where it reads
  // none, as for `count(*)`), each keeping its type and collation.
  ruled: ({ table, columns, where }, staging) => {
    const temp = sql.raw(`#r${staging.statements.length}`);
    const list =
      columns.length === 0
        ? sql`0 as ${sql.id("_")}`
        : sql.join(columns.map((c) => sql.id(c)));
    staging.statements.push(
      sql`drop table if exists ${temp}; select ${list} into ${temp} from ${table} where ${where};`
    );
    return temp;
  },
  ruledOnce: true,
  ownValue,
  ownMatch: (column, pattern, nativeType) =>
    OWN_TEXT.test(nativeType) ? like(column, pattern) : undefined,
  anchorPlus: (days) => sql`dateadd(day, ${days}, cast('1900-01-01' as date))`,
  // Truncates a float, an integer or a decimal toward zero alike.
  truncate: (n) => sql`cast(round(${n}, 0, 1) as int)`,
  // A CASE tree over the calendar's ordinals (integers the planner computed
  // from the admin's calendar, never query input): a row compares the bound
  // with a few of them, where a VALUES list or OPENJSON (which parses its
  // text on every row) reads them all.
  countWhere: (values, op, bound) => {
    const sorted = [...values].sort((a, b) => a - b);
    const keys = sorted.map((v) => sql.lit(v));
    return op === "<="
      ? search(bound, keys, (i) => sql.lit(i))
      : search(bound, keys, (i) =>
          i === 0
            ? sql.lit(0)
            : sql`case when ${bound} = ${keys[i - 1]!} then 1 else 0 end`
        );
  },
  // SQL Server knows Windows zone names only: the offset in effect is found
  // among the zone's spans over the window by a CASE tree on their starts,
  // and added to the instant; null outside the window. The instant passes
  // through MAX over its one row first, so the tree compares a value: SQL
  // Server would otherwise repeat its expression in every comparison. The
  // spans are the planner's, computed from the zone's rules, in a fixed form
  // checked here, never query input.
  zoneDate: (timestamp, zone) => {
    const instant = (at: string) =>
      sql`cast(${instantLit(at)} as datetime2(7))`;
    const { spans } = zone;
    const t = sql.id("zt", "t");
    const offset = search(
      t,
      spans.slice(1).map(({ s }) => instant(s)),
      (i) => sql.lit(spans[i]!.o)
    );
    return sql`(select cast(dateadd(second, case when ${t} >= ${instant(spans[0]!.s)} and ${t} < ${instant(spans.at(-1)!.e)} then ${offset} end, ${t}) as date) from (select max(${sql.id("zr", "t")}) as ${sql.id("t")} from (select ${timestamp} as ${sql.id("t")}) as ${sql.id("zr")}) as ${sql.id("zt")})`;
  },
  // SQL Server types a union's column over all its branches, and a bare null
  // (an int) takes the type of the others: no cast, so no decimal is resized.
  typedNull: () => sql`null`,
  timestampUtc: (expression, nativeType) =>
    baseType(nativeType) === "datetimeoffset"
      ? sql`cast(switchoffset(${expression}, '+00:00') as datetime2(7))`
      : expression,
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
