import type { Expression, Kysely, SelectQueryBuilder, SqlBool } from "kysely";
import type {
  AggregateFn,
  BucketUnit,
  Direction,
  PlanValue,
  QueryableType,
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
  /**
   * Binds a plan value as a parameter, with whatever cast the engine needs to
   * compare it with the subject. `nativeType` is the column's own type name,
   * absent for an aggregate.
   */
  value(value: PlanValue, subject: ValueSubject): Expression<unknown>;
  /** Truncates a `date` or `timestamp` column to the start of its UTC bucket, keeping its type. */
  bucket(
    unit: BucketUnit,
    column: Expression<unknown>,
    type: "date" | "timestamp"
  ): Expression<unknown>;
  /** Case-insensitive match against a pattern whose `\`, `%` and `_` are already escaped. */
  like(column: Expression<unknown>, pattern: string): Expression<SqlBool>;
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
  /** `"*"` only for `count`. */
  aggregate(
    fn: AggregateFn,
    arg: Expression<unknown> | "*"
  ): Expression<unknown>;
  page(qb: AnySelect, limit: number, offset: number): AnySelect;
}
