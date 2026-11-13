import type { ColumnType } from "./common.js";

/**
 * `(relation.)*column`: a bare column of the `from` table, or a column of a
 * joined table through its relation path (`customer.account.plan`).
 */
export type Path = string;

/** An output name: `^[a-z][a-z0-9_]{0,62}$`. */
export type Alias = string;

export type SelectItem =
  | Path
  | { count: string; as?: Alias }
  | { countDistinct: Path; as?: Alias }
  | { sum: Path; as?: Alias }
  | { avg: Path; as?: Alias }
  | { min: Path; as?: Alias }
  | { max: Path; as?: Alias }
  | {
      /** Truncated in UTC; weeks start on Monday. */
      bucket: "day" | "week" | "month" | "quarter" | "year";
      column: Path;
      as?: Alias;
    };

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
   * Each row an array in the order of `columns`, in wire forms: 64-bit
   * integers and decimals as strings, `count` and `countDistinct` as strings,
   * `sum` as a string over integers and decimals and a number over floats,
   * `avg` as a number; dates `YYYY-MM-DD`; timestamps ISO 8601 in UTC with
   * milliseconds.
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
