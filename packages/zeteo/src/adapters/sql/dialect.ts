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
  RowRuleAt,
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
  /** Where each statement's table is read, by statement: what a failed guard (`RuledRead.guard`) refuses with. */
  at: (RowRuleAt | undefined)[];
}

/**
 * The columns of a ruled table that are evaluated beside its rule, the
 * rule's own and those of the caller's conditions applied there, each with
 * its type as the catalogue last read it. Every comparison there was chosen
 * for that type: one with a column whose type has changed since may convert
 * the column per row and fail on a row the rule hides. A dialect that can
 * check them before the read (SQL Server) refuses the query when any differs
 * or has gone.
 */
export interface RuleGuard {
  schemaName: string;
  name: string;
  columns: readonly { name: string; nativeType: string }[];
  at?: RowRuleAt;
}

/**
 * What `ruled` reads of a table: the columns the query reads of it (none for
 * `count(*)` alone), and the rows the rule keeps. `rule` is the rule alone,
 * every value compared exactly, which is right whatever the table is.
 * `narrowed`, when it differs, is the rule with the caller's conditions that
 * cannot raise an error on any row of a base table (`ownValue`, `ownMatch`)
 * applied beside it, so an index can serve them, and with `apart` values left
 * out: right only where the table is a base table whose columns have the
 * catalogue's types and none is computed.
 */
export interface RuledRead {
  table: Expression<unknown>;
  columns: readonly string[];
  rule: Expression<SqlBool>;
  narrowed?: Expression<SqlBool>;
  guard: RuleGuard;
}

/** An equality's values, by what the subject's catalogue type says of them. */
export interface EqualityValues {
  /** Values the subject's type can hold. */
  held: PlanValue[];
  /** Values its type cannot hold but an exact comparison can still be made with: a column widened since the catalogue was read may hold them. */
  wider: PlanValue[];
  /**
   * Values its type cannot hold whose exact comparison with the column would
   * need a common type of more digits than the engine's exact numbers hold
   * (SQL Server: the column's integer digits plus the value's scale past
   * 38), so it could fail on a row. A row rule's narrowed read
   * (`RuledRead.narrowed`) leaves them out where they would add rows: it
   * runs on a base table only, after a check that the column still has the
   * catalogue's type (`RuleGuard`), which no such value equals. The rule
   * alone compares them exactly, as `wider` values are: a view's persisted
   * types, which the check reads, may be stale.
   */
  apart: PlanValue[];
  /** Whether some value can be compared exactly by no means (left out of all three): more digits than any exact number type of the engine holds. */
  unbound: boolean;
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
   * The values of an equality (`eq`, `ne`, `in`, `notIn`), sorted by whether
   * the subject can equal them, as the catalogue gives its type (which a
   * column changed since the last refresh may have outgrown); each is
   * written as `value` binds it exactly, and none is ever compared
   * inexactly. The compiler leaves out `wider` values only where that can
   * only drop rows (see `compileFilter`).
   */
  equalityValues(
    values: readonly PlanValue[],
    subject: ValueSubject
  ): EqualityValues;
  /**
   * `expression in (values)`, or `not in` when `negate`, with every value in
   * one bound parameter, so a long list (a row rule's identity values) takes
   * one of the engine's parameters, not one each: Postgres binds an array,
   * SQL Server a JSON array read with `openjson` (a few, when some values are
   * `wider` than the column's type). Each value is converted as `value`
   * converts it for the subject; `values` are `equalityValues`' `held` and
   * `wider`. `rule` binds them as `ruleValue` binds one, where it can.
   */
  inSet(
    expression: Expression<unknown>,
    values: readonly PlanValue[],
    subject: ValueSubject,
    negate: boolean,
    rule?: boolean
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
   * own, added to `staging`, run before the query. Only `read.where` is
   * evaluated on rows the rule leaves out: the rule, and conditions that
   * cannot raise.
   */
  ruled(read: RuledRead, staging: Staging): Expression<unknown>;
  /**
   * How a read decides whether it may apply `RuledRead.narrowed`: `live`,
   * when it runs, from the object's own metadata (SQL Server: a base table
   * with no computed column), else applying the rule alone, so the caller's
   * conditions moved beside the rule stay in the query's where too;
   * `catalogue`, at compile time, so they leave it: from the table's kind
   * as the catalogue last read it, and from what `compileSql`'s `narrow`
   * says (Postgres: the table's live metadata, checked before the query
   * runs, `adapters/postgres/ruleCheck.ts`).
   */
  narrowedCheck: "live" | "catalogue";
  /**
   * Whether one `ruled` read may serve every reference to the same table
   * with the same rule and conditions in a query (SQL Server: one temp table,
   * read under each alias).
   */
  ruledOnce: boolean;
  /**
   * `value` bound as exactly the column's own type (`nativeType`), so the
   * comparison converts nothing on the column's side and the value itself
   * cannot fail to convert, or undefined when the dialect cannot promise
   * that for this column and value. A comparison of the column, read as it
   * is, with what this returns raises no error on any row, so it may be
   * evaluated beside the rule, on rows the rule leaves out. It compares as
   * `value` does: the same rows match.
   */
  ownValue(
    value: PlanValue,
    subject: { type: QueryableType; nativeType: string }
  ): Expression<unknown> | undefined;
  /**
   * A row rule's value bound as exactly the column's catalogued type, so a
   * comparison with a column whose type has changed since the catalogue was
   * read fails when the statement is planned, before any row is read,
   * instead of comparing another way (Postgres infers an uncast parameter's
   * type from the column). Undefined where the dialect needs none (SQL
   * Server's read checks the column's type, `RuleGuard`) or cannot bind the
   * value so: it is then bound by `value`.
   */
  ruleValue(
    value: PlanValue,
    subject: { type: QueryableType; nativeType: string }
  ): Expression<unknown> | undefined;
  /**
   * `like`, for a column whose match can raise no error on any row, or
   * undefined. The same rows match as with `like`.
   */
  ownMatch(
    column: Expression<unknown>,
    pattern: string,
    nativeType: string
  ): Expression<SqlBool> | undefined;
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
