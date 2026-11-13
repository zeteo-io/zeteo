import type { ColumnType, QueryPlan } from "../types.js";

// The plan the SQL compiler consumes. It is complete: the compiler never reads
// the catalogue or the query. Every name in it is a real catalogue name, every
// value has been checked and coerced for the column it is compared with, and
// every table is addressed by its alias.

/** The column types a query can use; a column of type `other` never reaches a plan. */
export type QueryableType = Exclude<ColumnType, "other">;

export type JoinType = "inner" | "left";
export type AggregateFn =
  "count" | "countDistinct" | "sum" | "avg" | "min" | "max";
/** Buckets truncate in UTC. */
export type BucketUnit = "day" | "week" | "month" | "quarter" | "year";
export type Direction = "asc" | "desc";

export interface TableName {
  schemaName: string;
  name: string;
}

/** The `from` table, always alias `t0`. */
export interface ResolvedTable extends TableName {
  alias: "t0";
}

/** A catalogue column of one of the plan's tables. */
export interface ColumnRef {
  /** `t0` for the `from` table, `t1`… for joins. */
  alias: string;
  name: string;
  type: QueryableType;
  /** The database's own type name, such as `numeric(12,2)` or `bigint`. */
  nativeType: string;
}

export interface ResolvedJoin {
  /** `t1`… in the order the query gave its joins. */
  alias: string;
  /** The relation path as the query wrote it (`customer.account`), for messages only. */
  relation: string;
  table: TableName;
  type: JoinType;
  /** Equalities, all of which must hold: `parentAlias.parentColumn = alias.column`. */
  on: [parentAlias: string, parentColumn: string, column: string][];
}

/**
 * One result column. `output` is its name in the result, unique in the plan;
 * `type` is the type of the value it yields (`number` for every count, sum
 * and average).
 */
export type ResolvedSelect =
  | { kind: "column"; column: ColumnRef; output: string; type: QueryableType }
  | {
      kind: "aggregate";
      fn: AggregateFn;
      /** `"*"` only for `count`: `count(*)`. */
      column: ColumnRef | "*";
      output: string;
      type: QueryableType;
    }
  | {
      kind: "bucket";
      unit: BucketUnit;
      /** A `date` or `timestamp` column; the bucket keeps its type. */
      column: ColumnRef;
      output: string;
      type: QueryableType;
    };

/**
 * A filter value, coerced to the type of what it is compared with:
 * - `text`: a string;
 * - `number`: a finite JS number, or a decimal string (`-12.50`) kept as text
 *   so 64-bit integers and decimals lose nothing;
 * - `boolean`: a boolean;
 * - `date`: `YYYY-MM-DD`, a real calendar date;
 * - `timestamp`: ISO 8601 with `T`, seconds and an offset or `Z`
 *   (`2026-11-12T10:00:00.123+02:00`), as given.
 */
export type PlanValue = string | number | boolean;

export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/**
 * A filter tree over subjects `S`: catalogue columns in `where`, aggregate
 * select items in `having`. Several paths in one query object arrive as `and`.
 */
export type ResolvedFilter<S> =
  | { kind: "and" | "or"; filters: ResolvedFilter<S>[] }
  | { kind: "not"; filter: ResolvedFilter<S> }
  | { kind: "compare"; op: CompareOp; subject: S; value: PlanValue }
  /** Inclusive at both ends. */
  | { kind: "between"; subject: S; low: PlanValue; high: PlanValue }
  /** One to 1,000 values. */
  | { kind: "in"; op: "in" | "notIn"; subject: S; values: PlanValue[] }
  /** Case-insensitive; `value` is the raw text, `%` and `_` not yet escaped. Text only. */
  | {
      kind: "match";
      op: "contains" | "startsWith";
      subject: S;
      value: string;
    }
  /** `isNull: false` means IS NOT NULL. */
  | { kind: "isNull"; subject: S; isNull: boolean };

/** An aggregate select item, by index into `select`, and the type it yields. */
export interface HavingSubject {
  index: number;
  type: QueryableType;
}

export type OrderTarget =
  { kind: "output"; index: number } | { kind: "column"; column: ColumnRef };

export interface ResolvedOrder {
  /** A select item by index, or a column that is not selected (only in ungrouped, non-distinct queries). */
  target: OrderTarget;
  direction: Direction;
}

export interface SqlPlan extends QueryPlan {
  from: ResolvedTable;
  /** In query order; each join's parent alias is the `from` table's or an earlier join's. */
  joins: ResolvedJoin[];
  /** One to 50 items, in the order of `columns`. */
  select: ResolvedSelect[];
  distinct: boolean;
  where: ResolvedFilter<ColumnRef> | undefined;
  /**
   * Indexes into `select` to group by: every non-aggregate item when the query
   * is grouped (it has an aggregate or a `groupBy`), else empty. Empty with
   * aggregates means one group over all rows.
   */
  groupBy: number[];
  /** Only when the query has an aggregate. */
  having: ResolvedFilter<HavingSubject> | undefined;
  /** Never empty: with no `orderBy` in the query, every select item ascending, in order. */
  orderBy: ResolvedOrder[];
}
