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

/** A date literal, `YYYY-MM-DD`. */
export interface DateLiteral {
  date: string;
}

/** A timestamp literal, ISO 8601 with an offset or `Z`. */
export interface TimestampLiteral {
  timestamp: string;
}

/** The unit of `dateAdd` and `dateDiff`. */
export type DateUnit = "day" | "week" | "month" | "quarter" | "year";

/** The unit of `dateDiff`: also whole seconds, minutes or hours. */
export type DateDiffUnit = "second" | "minute" | "hour" | DateUnit;

/**
 * What `datePart` takes out of a date; `weekday` is 1 for Monday to 7 for
 * Sunday; `business_day` is which business day of its month the date is. A
 * timestamp is read as its date in the calendar's time zone.
 */
export type DatePart =
  | "year"
  | "quarter"
  | "month"
  | "day"
  | "weekday"
  | "fiscal_year"
  | "fiscal_quarter"
  | "business_day";

/** The period a business-day count spans; a week starts on Monday. */
export type PeriodUnit =
  "week" | "month" | "quarter" | "year" | "fiscal_quarter" | "fiscal_year";

/**
 * A calculation expression: a column path, a number, a text, date or
 * timestamp literal, a relative date, a measure, an aggregate, or an
 * operation object with exactly one key. At most 8 levels deep (an aggregate
 * counts as one), and 100 operations and aggregates per query (a measure's
 * expansion is counted apart, at most 500 in all). `add`, `mul`, `concat` and
 * `coalesce` take 2 to 10 operands.
 */
export type CalcExpr =
  | Path
  | number
  | TextLiteral
  | DateLiteral
  | TimestampLiteral
  | RelativeDate
  /** A measure of the query's `from` table; group-level, and never inside an aggregate. */
  | { measure: Alias }
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
  /** A path, `"*"` or an expression. */
  | { count: CalcExpr }
  | { countDistinct: CalcExpr }
  /** `[date or timestamp, amount (-10,000 to 10,000), unit]`; a month, quarter or year step clamps to the month's last day. */
  | { dateAdd: [CalcExpr, number, DateUnit] }
  /** `[unit, start, end]`: whole units completed, negative when end is before start. */
  | { dateDiff: [DateDiffUnit, CalcExpr, CalcExpr] }
  /** `[part, date or timestamp]`: a number; fiscal parts follow the calendar. */
  | { datePart: [DatePart, CalcExpr] }
  /**
   * The calendar's business days from start to end, both inclusive, 0 when
   * end is first. Every business-day operand is any date or timestamp
   * expression; a timestamp is read as its date in the calendar's time zone.
   */
  | { businessDays: [CalcExpr, CalcExpr] }
  /** Business days after start through end: negative when end is first. */
  | { businessDaysBetween: [CalcExpr, CalcExpr] }
  /** The business days of the period of `unit` holding the date. */
  | { businessDaysIn: [PeriodUnit, CalcExpr] }
  | { businessDaysInMonth: CalcExpr }
  /** The period's (the month's without a unit) first day through the date. */
  | { businessDaysElapsed: CalcExpr | [PeriodUnit, CalcExpr] }
  /** After the date through the period's (the month's without a unit) end. */
  | { businessDaysRemaining: CalcExpr | [PeriodUnit, CalcExpr] }
  /** `[date, n]`: the date n business days later (earlier when n < 0), as WORKDAY; n = 0 gives the next business day. */
  | { addBusinessDays: [CalcExpr, CalcExpr] }
  /** In a metric's formula only: the business days of each period, or of the range. */
  | { businessDaysInPeriod: true }
  /**
   * The `then` of the first branch whose `if` holds, else `else` (null without
   * one); 1 to 10 branches, every `then` and the `else` of one type.
   */
  | { case: { when: { if: Filter; then: CalcExpr }[]; else?: CalcExpr } };

type ExpressionAggregate<
  K extends "sum" | "avg" | "min" | "max" | "count" | "countDistinct",
> =
  | ({ [P in K]: Path } & { as?: Alias })
  | ({ [P in K]: Exclude<CalcExpr, Path> } & { as: Alias });

export type SelectItem =
  | Path
  | { count: string; as?: Alias }
  | { countDistinct: Path; as?: Alias }
  | ExpressionAggregate<"count">
  | ExpressionAggregate<"countDistinct">
  /** Over an expression rather than a path, `as` is required. */
  | ExpressionAggregate<"sum">
  | ExpressionAggregate<"avg">
  | ExpressionAggregate<"min">
  | ExpressionAggregate<"max">
  | {
      /**
       * The first day of the period, a date; weeks start on Monday. A
       * timestamp is bucketed by its date in the calendar's time zone. A
       * fiscal bucket gives the start of the fiscal quarter or year, which
       * follows the calendar.
       */
      bucket: BucketUnit;
      column: Path;
      as?: Alias;
    }
  /** Row-level (no aggregate) or group-level (every column inside an aggregate), not mixed. */
  | { calc: CalcExpr; as: Alias }
  /**
   * A measure of the source, over the query's `from` table, which must be the
   * measure's home table. Group-level, like an aggregate; the output name is
   * `as`, else the measure's name.
   */
  | { measure: Alias; as?: Alias };

export type JoinItem = Path | { relation: Path; type?: "inner" | "left" };

export type FilterValue = string | number | boolean | null;

/**
 * A moment relative to now, for a date or timestamp column:
 * `{ relative: { unit: "day", offset: -30 } }` is 30 days before now, and with
 * `startOf` it is cut back to the start of the unit (`{ unit: "month",
 * offset: 0, startOf: true }` is the start of this month). Resolved against
 * the minute the run starts, in the calendar's time zone (`UTC` by default);
 * a week starts on Monday and the fiscal units follow the calendar's fiscal
 * year. A saved query keeps it relative.
 */
export interface RelativeDate {
  relative: {
    unit:
      | "minute"
      | "hour"
      | "day"
      | "week"
      | "month"
      | "quarter"
      | "year"
      | "fiscal_quarter"
      | "fiscal_year";
    /** Whole units from now, -1000 to 1000; negative is the past. */
    offset: number;
    startOf?: boolean;
  };
}

/** A date bucket's unit. */
export type BucketUnit =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "fiscal_quarter"
  | "fiscal_year";

/**
 * What a comparison takes: a value, a moment relative to now, or a fixed
 * measure (`{ measure: name }`, one value of any table; not for `in`,
 * `notIn` or `between`).
 */
export type ComparedValue = FilterValue | RelativeDate | { measure: string };

export interface FilterOperators {
  eq?: ComparedValue;
  ne?: ComparedValue;
  gt?: ComparedValue;
  gte?: ComparedValue;
  lt?: ComparedValue;
  lte?: ComparedValue;
  /** Two values, inclusive. */
  between?: [
    Exclude<ComparedValue, { measure: string }>,
    Exclude<ComparedValue, { measure: string }>,
  ];
  /** 1 to 1,000 values. */
  in?: FilterValue[];
  notIn?: FilterValue[];
  /** Text, case-insensitive; `%` and `_` are literal. */
  contains?: string;
  startsWith?: string;
  isNull?: boolean;
  /** A date or timestamp that is (true) or is not (false) a business day; not in `having`. */
  isBusinessDay?: boolean;
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

export interface TableQuery {
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

/** A bound of a metric query's `range`. */
export type RangeBound =
  { date: string } | { timestamp: string } | RelativeDate;

/** Half-open bounds on each measure's date column: `gte`, `lt` or both. */
export type MetricRange =
  { gte: RangeBound; lt?: RangeBound } | { gte?: RangeBound; lt: RangeBound };

/**
 * Measures and metrics of different tables of one source, combined per
 * period; told apart from a table query by its `metrics` key. The result is
 * `period` (the bucket's first day, a date, when `bucket` is given) then one
 * column per name, in order.
 * `bucket` and `range` apply to each non-fixed measure's own `date_column`.
 * There is no `where`, `join`, `groupBy` or `having`.
 */
export interface MetricQuery {
  /** The source's slug. */
  source: string;
  /** 1 to 20 names of measures or metrics, each once. */
  metrics: string[];
  bucket?: BucketUnit;
  range?: MetricRange;
  /** Each entry one `{ "<name>": "asc" | "desc" }`, naming `period` or a requested name. */
  orderBy?: Record<string, "asc" | "desc">[];
  /** Default 1,000. */
  limit?: number;
  /** 0 to 1,000,000. */
  offset?: number;
}

/** A table query or a metric query. */
export type Query = TableQuery | MetricQuery;

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
