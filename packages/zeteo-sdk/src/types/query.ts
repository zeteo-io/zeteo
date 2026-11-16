import type { ColumnType } from "./common.js";

/**
 * `(relation.)*column`: a bare column of the `from` table, or a column of a
 * joined table through its relation path (`customer.account.plan`).
 */
export type Path = string;

/** An output name: `^[a-z][a-z0-9_]{0,62}$`. */
export type Alias = string;

/** A text literal; a bare string in an expression is a column path. */
export interface TextLiteral {
  value: string;
}

/**
 * A calculation expression: a column path, a number, a text literal, an
 * aggregate, or an operation object with exactly one key. At most 5 levels
 * deep (an aggregate counts as one), and 100 operations and aggregates per
 * query. `add`, `mul`, `concat` and `coalesce` take 2 to 10 operands.
 */
export type CalcExpr =
  | Path
  | number
  | TextLiteral
  | { add: CalcExpr[] }
  | { sub: [CalcExpr, CalcExpr] }
  | { mul: CalcExpr[] }
  /** Division by zero gives null; the result keeps at least 6 decimal places. */
  | { div: [CalcExpr, CalcExpr] }
  | { abs: CalcExpr }
  /** `[expression, places]` with places an integer 0 to 10, or one expression for 0 places. */
  | { round: CalcExpr | [CalcExpr, number] }
  /** Text or number operands; null counts as empty text. */
  | { concat: CalcExpr[] }
  | { lower: CalcExpr }
  | { upper: CalcExpr }
  /** Operands of one type; the first non-null. */
  | { coalesce: CalcExpr[] }
  | { sum: CalcExpr }
  | { avg: CalcExpr }
  | { min: CalcExpr }
  | { max: CalcExpr }
  | { count: Path | "*" }
  | { countDistinct: Path };

type ExpressionAggregate<K extends "sum" | "avg" | "min" | "max"> =
  | ({ [P in K]: Path } & { as?: Alias })
  | ({ [P in K]: Exclude<CalcExpr, Path> } & { as: Alias });

export type SelectItem =
  | Path
  | { count: string; as?: Alias }
  | { countDistinct: Path; as?: Alias }
  /** Over an expression rather than a path, `as` is required. */
  | ExpressionAggregate<"sum">
  | ExpressionAggregate<"avg">
  | ExpressionAggregate<"min">
  | ExpressionAggregate<"max">
  | {
      /** Truncated in UTC; weeks start on Monday. */
      bucket: "day" | "week" | "month" | "quarter" | "year";
      column: Path;
      as?: Alias;
    }
  /** Row-level (no aggregate) or group-level (every column inside an aggregate), not mixed. */
  | { calc: CalcExpr; as: Alias };

export type JoinItem = Path | { relation: Path; type?: "inner" | "left" };

export type FilterValue = string | number | boolean | null;

export interface FilterOperators {
  eq?: FilterValue;
  ne?: FilterValue;
  gt?: FilterValue;
  gte?: FilterValue;
  lt?: FilterValue;
  lte?: FilterValue;
  /** Two values, inclusive. */
  between?: [FilterValue, FilterValue];
  /** 1 to 1,000 values. */
  in?: FilterValue[];
  notIn?: FilterValue[];
  /** Text, case-insensitive; `%` and `_` are literal. */
  contains?: string;
  startsWith?: string;
  isNull?: boolean;
}

/**
 * `and`, `or` and `not` are reserved: a column with one of those names cannot
 * be filtered on directly. In `having`, the keys are aggregate select items'
 * names. Filters nest at most 5 deep.
 */
export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { [path: string]: FilterOperators };

export interface Query {
  /** The source's slug. */
  source: string;
  /** A table or view: its bare name when unique among the source's schemas, else `schema.table`. */
  from: string;
  /** At most 4. */
  join?: JoinItem[];
  /** 1 to 50 items. */
  select: SelectItem[];
  distinct?: boolean;
  where?: Filter;
  /** Select items, by output name or column path; at most 50. */
  groupBy?: string[];
  having?: Filter;
  /** Each entry one `{ "<name>": "asc" | "desc" }`; at most 50. */
  orderBy?: Record<string, "asc" | "desc">[];
  /** Default 1,000; a value above the maximum is lowered to it, not refused. */
  limit?: number;
  /** 0 to 1,000,000. */
  offset?: number;
}

export interface QueryWarning {
  code: "join_multiplies_rows";
  message: string;
  path: (string | number)[];
}

export interface QueryResult {
  columns: { name: string; type: ColumnType }[];
  /**
   * Each row an array in the order of `columns`, in wire forms: 32-bit
   * integers and floats as numbers (float `NaN` and infinities as strings),
   * 64-bit integers and decimals as strings, `count` and `countDistinct` as strings,
   * `sum` as a string over integers and decimals and a number over floats,
   * `avg` as a number; dates `YYYY-MM-DD`; timestamps ISO 8601 in UTC with
   * milliseconds; json as JSON.
   */
  rows: unknown[][];
  /** Rows were left out. */
  truncated: boolean;
  /** Present when `truncated`. */
  truncated_by?: "rows" | "bytes";
  warnings: QueryWarning[];
  /** The run's id in the run log. */
  run_id: string;
}
