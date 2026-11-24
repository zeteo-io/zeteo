import type { Expression, Kysely, SelectQueryBuilder, SqlBool } from "kysely";
import type { DateAddUnit, DateDiffUnit, DatePart } from "./language.js";
import type { ZoneWindow } from "../../calendar/calendar.js";
import type {
  AggregateFn,
  BucketUnit,
  Direction,
  PlanValue,
  QueryableType,
  ResolvedExpr,
  ResolvedSelect,
} from "./types.js";

/** The `dateDiff` units within a day, in seconds. */
export const SECONDS_IN = { second: 1, minute: 60, hour: 3600 } as const;

// The compile-only instance has no schema, so its tables and columns are untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any;
export type AnyKysely = Kysely<Untyped>;
export type AnySelect = SelectQueryBuilder<Untyped, Untyped, Untyped>;

export interface ValueSubject {
  type: QueryableType;
  nativeType?: string;
}

export interface SelectItemRef {
  expression: Expression<unknown>;
  index: number;
}

/**
 * The few places where SQL engines differ. Identifier quoting is not one of
 * them: it comes from the dialect's own Kysely instance, which never connects.
 */
/**
 * Months a fiscal bucket shifts back before truncating and forward after: its
 * period starts that many months after the calendar year's (or quarter's)
 * start. Zero for a calendar unit and when the fiscal year starts in January.
 */
export const fiscalShift = (unit: BucketUnit, startMonth: number): number => {
  if (unit === "fiscal_year") return startMonth - 1;
  if (unit === "fiscal_quarter") return (startMonth - 1) % 3;
  return 0;
};

/** The calendar unit a bucket truncates to once shifted. */
export const truncUnit = (unit: BucketUnit): string =>
  unit === "fiscal_year"
    ? "year"
    : unit === "fiscal_quarter"
      ? "quarter"
      : unit;

/** The statements a query runs before its SELECT, in order: SQL Server's ruled tables. */
export interface Staging {
  statements: Expression<unknown>[];
}

export interface SqlDialect {
  name: "postgres" | "mssql";
  /** Builds and compiles queries only; its driver is a dummy. */
  kysely: AnyKysely;
  /** The most parameters one statement may bind. */
  maxParameters: number;
  /**
   * A catalogue column as every part of the query reads it, given its own
   * type name: an engine casts what it cannot compare, sort or group as it is.
   * Join keys are compared as they are.
   */
  column(
    expression: Expression<unknown>,
    nativeType: string
  ): Expression<unknown>;
  /**
   * Binds a plan value as a parameter, with whatever cast the engine needs to
   * compare it with the subject. `nativeType` is the column's own type name,
   * absent for an aggregate.
   */
  value(value: PlanValue, subject: ValueSubject): Expression<unknown>;
  /**
   * `expression in (values)`, or `not in` when `negate`, with every value in
   * one bound parameter, so a long list (a row rule's identity values) takes
   * one of the engine's parameters, not one each: Postgres binds an array,
   * SQL Server a JSON array read with `openjson`. Each value is converted as
   * `value` converts it for the subject.
   */
  inSet(
    expression: Expression<unknown>,
    values: readonly PlanValue[],
    subject: ValueSubject,
    negate: boolean
  ): Expression<SqlBool>;
  /**
   * The first day of the period holding `date` (a date expression), as a
   * date. A fiscal unit starts its year at `fiscalStartMonth` (1-12). A
   * timestamp is bucketed by its date, which the compiler reads first.
   */
  bucket(
    unit: BucketUnit,
    date: Expression<unknown>,
    fiscalStartMonth: number
  ): Expression<unknown>;
  /**
   * Case-insensitive match against a pattern whose `\`, `%` and `_` are
   * already escaped; the dialect escapes whatever else its LIKE treats as
   * special. `nativeType` is the column's own type name, absent for an
   * aggregate.
   */
  like(
    column: Expression<unknown>,
    pattern: string,
    nativeType?: string
  ): Expression<SqlBool>;
  /**
   * Groups by select items, each given as its expression and its position in
   * `select` (0-based), so the dialect can group by either.
   */
  groupBy(qb: AnySelect, items: SelectItemRef[]): AnySelect;
  /**
   * Orders with nulls last ascending and first descending, spelled out. A
   * select item comes with its alias as well as its expression; a column that
   * is not selected has no alias.
   */
  orderBy(
    qb: AnySelect,
    target: { expression: Expression<unknown>; alias?: Expression<unknown> },
    direction: Direction
  ): AnySelect;
  /**
   * Returns every row once, given every select item. `grouped` says the
   * query already groups (by every item that is not an aggregate), so its
   * rows are distinct already.
   */
  distinct(qb: AnySelect, items: SelectItemRef[], grouped: boolean): AnySelect;
  /**
   * A calculation's literal, bound: an integer in bigint's range as bigint,
   * any other number as an exact decimal where one holds it, text as text.
   * A number comes as plain decimal text (`plainNumber`).
   */
  literal(
    value: string,
    type: "number" | "text" | "date" | "timestamp"
  ): Expression<unknown>;
  /**
   * A date or timestamp shifted by `amount` (an integer from -10,000 to
   * 10,000) units, keeping its type. A month, quarter or year step that lands
   * past the end of a month gives that month's last day.
   */
  dateAdd(
    expression: Expression<unknown>,
    amount: number,
    unit: DateAddUnit,
    type: "date" | "timestamp"
  ): Expression<unknown>;
  /**
   * The whole `unit`s completed from `start` to `end` as an integer,
   * truncated toward zero (negative when `end` is before `start`). A month
   * is complete when `start` plus those months, clamped as `dateAdd` clamps,
   * is not past `end`. Both are read as `type`, the wider of their own.
   */
  dateDiff(
    unit: DateDiffUnit,
    start: Expression<unknown>,
    end: Expression<unknown>,
    type: "date" | "timestamp"
  ): Expression<unknown>;
  /**
   * A part of a date or timestamp (a timestamp's UTC wall clock: the compiler
   * reads a timestamp's date in a calendar's zone first) as an integer;
   * `weekday` is 1 for Monday to 7 for Sunday, a fiscal part follows a fiscal
   * year starting in `fiscalStartMonth` (1-12) and named by the year it ends in.
   */
  datePart(
    part: Exclude<DatePart, "business_day">,
    expression: Expression<unknown>,
    fiscalStartMonth: number
  ): Expression<unknown>;
  /**
   * A null standing for a number in a union's column: a float when
   * `approximate`, else an exact decimal (which every integer and decimal
   * value of the column keeps its digits in).
   */
  typedNull(approximate: boolean): Expression<unknown>;
  /**
   * A timestamp column as a calculation reads it: the instant in UTC, so a
   * column with an offset (SQL Server's datetimeoffset) is not read as its
   * local wall time. Other columns are returned as they are.
   */
  timestampUtc(
    expression: Expression<unknown>,
    nativeType: string
  ): Expression<unknown>;
  /**
   * Whether an aggregate may take a scalar subquery (Postgres); where it may
   * not (SQL Server), a row-level business-day computation is applied to the
   * rows instead and read as a column.
   */
  subqueryInAggregate: boolean;
  /**
   * A table limited by the caller's row rule, as what the query reads in its
   * place. No expression the caller wrote may be evaluated on a row the rule
   * leaves out: an error it raised there (an overflow, a date out of range)
   * would tell the caller something about that row, and neither engine keeps
   * a derived table's condition ahead of the conditions around it. Postgres
   * reads it as a MATERIALIZED WITH query, computed separately from the query
   * around it; SQL Server copies it into a temp table by a statement of its
   * own, added to `staging`, run before the query.
   */
  ruled(
    table: Expression<unknown>,
    rule: Expression<SqlBool>,
    staging: Staging
  ): Expression<unknown>;
  /**
   * How each one-row step of a business-day subquery is fenced so its values
   * are computed once per row: `offset 0` after it (Postgres keeps such a
   * subquery a step), or each value through MAX over the step's one row (SQL
   * Server substitutes a derived table's expressions into every reference,
   * `top 1` or not, but reads an aggregate's output as a column). Unfenced,
   * a step's expression (a timestamp's conversion among them) would be
   * repeated wherever a later step reads it.
   */
  stepFence: "offset" | "aggregate";
  /** The date `days` (an integer expression) days after 1900-01-01. */
  anchorPlus(days: Expression<unknown>): Expression<unknown>;
  /** A number truncated toward zero to an integer; the caller keeps it within ±3,000,000. */
  truncate(n: Expression<unknown>): Expression<unknown>;
  /**
   * How many of `values` (integers from the plan's calendar) are `op`
   * `bound`: with `=`, 1 or 0, as the values are distinct.
   */
  countWhere(
    values: readonly number[],
    op: "<=" | "=",
    bound: Expression<unknown>
  ): Expression<unknown>;
  /**
   * A UTC timestamp's date in `zone`, null outside the zone's window. The
   * timestamp is the instant as a calculation reads it (`timestampUtc`).
   */
  zoneDate(
    timestamp: Expression<unknown>,
    zone: ZoneWindow
  ): Expression<unknown>;
  /** A text column as a calculation's text functions take it (a uuid as its text). */
  text(
    expression: Expression<unknown>,
    nativeType: string
  ): Expression<unknown>;
  /** Whether a number column of this type holds binary floating point. */
  isFloat(nativeType: string): boolean;
  /**
   * `a / b` as a decimal rounded half away from zero to exactly 6 places,
   * null when `b` is 0. `a` is read to 18 places, `b` to 10, so integers
   * never truncate and both engines compute the same value.
   */
  divide(a: Expression<unknown>, b: Expression<unknown>): Expression<unknown>;
  /** Rounds half away from zero to exactly `places` (0–10) decimal places. */
  round(a: Expression<unknown>, places: number): Expression<unknown>;
  /**
   * A number as text, the same on every engine: no exponent, and a decimal's
   * own scale. A float (`approximate`) is written to at most 10 places with
   * no trailing zeros.
   */
  numberToText(
    a: Expression<unknown>,
    approximate: boolean
  ): Expression<unknown>;
  /** Text parts joined, a null part as empty text; all nulls give `''`. */
  concat(parts: Expression<unknown>[]): Expression<unknown>;
  /**
   * `"*"` only for `count`. `nativeType` is the column's own type name; for
   * an expression, `expr` is the planned argument instead.
   */
  aggregate(
    fn: AggregateFn,
    arg: Expression<unknown> | "*",
    nativeType?: string,
    expr?: ResolvedExpr
  ): Expression<unknown>;
  /**
   * A select item's value as the select list returns it, in a form the
   * engine's driver reads without loss. Grouping, having and ordering use
   * the expression as it is.
   */
  output(
    item: ResolvedSelect,
    expression: Expression<unknown>
  ): Expression<unknown>;
  /** `ordered` says whether the query has an ORDER BY. */
  page(
    qb: AnySelect,
    limit: number,
    offset: number,
    ordered: boolean
  ): AnySelect;
}
