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

/**
 * The few places where SQL engines differ. Identifier quoting is not one of
 * them: it comes from the dialect's own Kysely instance, which never connects.
 */
export interface SqlDialect {
  name: "postgres" | "mssql";
  /** Builds and compiles queries only; its driver is a dummy. */
  kysely: AnyKysely;
  /** Binds a plan value as a parameter, with whatever cast the engine needs to compare it with `type`. */
  value(value: PlanValue, type: QueryableType): Expression<unknown>;
  /** Truncates a `date` or `timestamp` column to the start of its UTC bucket, keeping its type. */
  bucket(
    unit: BucketUnit,
    column: Expression<unknown>,
    type: "date" | "timestamp"
  ): Expression<unknown>;
  /** Case-insensitive match against a pattern whose `\`, `%` and `_` are already escaped. */
  like(column: Expression<unknown>, pattern: string): Expression<SqlBool>;
  /** Orders with nulls last ascending and first descending, spelled out. */
  orderBy(
    qb: AnySelect,
    expression: Expression<unknown>,
    direction: Direction
  ): AnySelect;
  /** `"*"` only for `count`. */
  aggregate(
    fn: AggregateFn,
    arg: Expression<unknown> | "*"
  ): Expression<unknown>;
  page(qb: AnySelect, limit: number, offset: number): AnySelect;
}
