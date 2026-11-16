import type { Expression, Kysely, SelectQueryBuilder, SqlBool } from "kysely";
import type {
  AggregateFn,
  BucketUnit,
  Direction,
  PlanValue,
  QueryableType,
  ResolvedExpr,
  ResolvedSelect,
} from "./types.js";

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
   * Truncates a `date` or `timestamp` column to the start of its UTC bucket,
   * keeping its type. `nativeType` is the column's own type name.
   */
  bucket(
    unit: BucketUnit,
    column: Expression<unknown>,
    type: "date" | "timestamp",
    nativeType: string
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
  literal(value: string, type: "number" | "text"): Expression<unknown>;
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
