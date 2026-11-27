import { relativeDateSchema, type RelativeDate } from "./relative.js";
import type { RuleFilter } from "../../row-rules/types.js";
import type { QueryLanguage } from "../types.js";
import { planSql, queryNameOf } from "./plan.js";
import { planMetrics } from "./metrics.js";
import type { SqlPlan } from "./types.js";
import { z } from "zod";

// The SQL-shaped JSON query language shared by every SQL source. Every object
// is strict; expressions are the closed operation set below, nested to a limit.

export const MAX_SELECT_ITEMS = 50;
/** The hard ceiling on joins in one query; each source's own `max_joins` (at most this) is checked by the planner. */
export const MAX_JOINS = 8;
export const MAX_FILTER_DEPTH = 5;
export const MAX_IN_VALUES = 1000;
export const MAX_OFFSET = 1_000_000;
const MAX_SEGMENT_CHARS = 128;
/** groupBy and orderBy name select items or columns; neither needs more entries than select has. */
const MAX_KEYS = MAX_SELECT_ITEMS;

const noNul = (s: string) => !s.includes("\u0000");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `(<relation>.)*<column>`: segments of 1–128 characters, any but `.` and NUL. */
const pathSchema = z
  .string()
  .refine(
    (s) =>
      s
        .split(".")
        .every((seg) => seg.length >= 1 && seg.length <= MAX_SEGMENT_CHARS) &&
      noNul(s),
    {
      error: `A path is (relation.)*column, each segment 1–${MAX_SEGMENT_CHARS} characters with no NUL`,
    }
  );

/** `table` or `schema.table`; a name may itself hold dots, so it is matched whole. */
const tableNameSchema = z
  .string()
  .min(1)
  .max(2 * MAX_SEGMENT_CHARS + 1)
  .refine(noNul, { error: "A table name has no NUL" });

const aliasSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error: "An alias is a lowercase letter then up to 62 of a-z, 0-9 and _",
});

const scalarSchema = z.union([
  z.string().refine(noNul, { error: "A value has no NUL" }),
  z.number(),
  z.boolean(),
]);

/** A measure's name: the form of an `as` alias. */
const measureNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error:
    "A measure's name is a lowercase letter then up to 62 of a-z, 0-9 and _",
});
const measureRefSchema = z.strictObject({ measure: measureNameSchema });

/** A value a comparison takes: a literal, a moment relative to now, or a fixed measure. */
const comparedSchema = z.union([
  scalarSchema,
  relativeDateSchema,
  measureRefSchema,
]);

export const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "isNull",
  "isBusinessDay",
] as const;
export type Operator = (typeof OPERATORS)[number];

const valuesSchema = z.array(scalarSchema).min(1).max(MAX_IN_VALUES);

/** The name of an identity key; the same shape the database enforces. */
export const IDENTITY_KEY_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A row rule's value taken from the caller's identity; only rules may use it. */
export const identityRefSchema = z.strictObject({
  identity: z.string().regex(IDENTITY_KEY_NAME, {
    error:
      "An identity key name is a lowercase letter then up to 63 of a-z, 0-9 and _",
  }),
  below: z.boolean().optional(),
});

/** Exactly one operator and its value; `identity` also admits identity references in `eq`, `ne`, `in` and `notIn`. */
const makeConditionSchema = (identity: boolean) => {
  const eqNe = identity
    ? z.union([comparedSchema, identityRefSchema])
    : comparedSchema;
  const list = identity
    ? z.union([valuesSchema, identityRefSchema])
    : valuesSchema;
  return z.union(
    [
      z.strictObject({ eq: eqNe }),
      z.strictObject({ ne: eqNe }),
      z.strictObject({ gt: comparedSchema }),
      z.strictObject({ gte: comparedSchema }),
      z.strictObject({ lt: comparedSchema }),
      z.strictObject({ lte: comparedSchema }),
      z.strictObject({ between: z.tuple([comparedSchema, comparedSchema]) }),
      z.strictObject({ in: list }),
      z.strictObject({ notIn: list }),
      z.strictObject({ contains: z.string().refine(noNul) }),
      z.strictObject({ startsWith: z.string().refine(noNul) }),
      z.strictObject({ isNull: z.boolean() }),
      z.strictObject({ isBusinessDay: z.boolean() }),
    ],
    {
      error: `Each path takes exactly one operator: ${OPERATORS.join(", ")}`,
    }
  );
};

/** Keys that are always logical operators, never column paths. */
const LOGICAL_KEYS = new Set(["and", "or", "not"]);
/**
 * The one key parsing cannot keep: Zod rebuilds the object by assignment,
 * where `__proto__` sets the prototype rather than a key, so the condition
 * would be lost. It is refused as a path, never dropped. Any other name
 * (`constructor`, `prototype`) is an own key like a column's, and paths are
 * looked up by `Map` and read with `Object.entries`.
 */
const PROTO_KEY = "__proto__";

export type Scalar = string | number | boolean;
/** `{ measure }` names a fixed measure; the planner refuses any other. */
export type Compared = Scalar | RelativeDate | { measure: string };
export type Condition =
  | { eq: Compared }
  | { ne: Compared }
  | { gt: Compared }
  | { gte: Compared }
  | { lt: Compared }
  | { lte: Compared }
  | { between: [Compared, Compared] }
  | { in: Scalar[] }
  | { notIn: Scalar[] }
  | { contains: string }
  | { startsWith: string }
  | { isNull: boolean }
  | { isBusinessDay: boolean };
/** Paths to conditions; several paths mean all of them. */
export type Comparison = Record<string, Condition>;
export type Filter =
  { and: Filter[] } | { or: Filter[] } | { not: Filter } | Comparison;

const tooDeep = z.never({
  error: `Filters nest at most ${MAX_FILTER_DEPTH} levels deep`,
});

/**
 * A filter object at `depth`; a filter directly under `where` or `having` is
 * depth 1, and whatever an `and`, `or` or `not` holds is one deeper. At the
 * deepest level `and`, `or` and `not` are refused. The levels are built out
 * rather than recursive, so parsing stops at the limit however deep the input
 * goes. One object type rather than a union keeps each issue's path exact.
 */
const filterAt = (
  depth: number,
  identity: boolean
): z.ZodType<Filter | RuleFilter> => {
  const inner =
    depth < MAX_FILTER_DEPTH ? filterAt(depth + 1, identity) : undefined;
  const object = z
    .object({
      and: (inner ? z.array(inner).min(1) : tooDeep).optional(),
      or: (inner ? z.array(inner).min(1) : tooDeep).optional(),
      not: (inner ?? tooDeep).optional(),
    })
    .catchall(makeConditionSchema(identity))
    .superRefine((filter, ctx) => {
      const keys = Object.keys(filter);
      if (keys.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "A filter names at least one path",
        });
      }
      if (keys.some((k) => LOGICAL_KEYS.has(k)) && keys.length > 1) {
        ctx.addIssue({
          code: "custom",
          message: "and, or and not each stand alone in their filter object",
        });
      }
      for (const key of keys) {
        if (!LOGICAL_KEYS.has(key) && !pathSchema.safeParse(key).success) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `A path is (relation.)*column, each segment 1–${MAX_SEGMENT_CHARS} characters with no NUL`,
          });
        }
      }
    });
  // Checked on the input as sent: parsing rebuilds the object and would drop
  // a `__proto__` key without a word, losing that condition.
  const node = z
    .preprocess((input, ctx) => {
      if (isPlainObject(input)) {
        if (Object.hasOwn(input, PROTO_KEY)) {
          ctx.issues.push({
            code: "custom",
            input,
            path: [PROTO_KEY],
            message: `"${PROTO_KEY}" cannot be a path`,
          });
        }
      }
      return input;
    }, object)
    .meta({
      description:
        "One of { and: [filter] }, { or: [filter] }, { not: filter }, or { path: { operator: value }, ... } where several paths must all hold",
    });
  return node as unknown as z.ZodType<Filter | RuleFilter>;
};

/** The filter schema; `identity: true` is for row rules, which may compare to the caller's identity. */
export const makeFilterSchema = (opts: {
  identity: boolean;
}): z.ZodType<Filter | RuleFilter> => filterAt(1, opts.identity);

const filterSchema = makeFilterSchema({
  identity: false,
}) as z.ZodType<Filter>;

export const BUCKET_UNITS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_quarter",
  "fiscal_year",
] as const;

export const CALC_OPS = [
  "add",
  "sub",
  "mul",
  "div",
  "abs",
  "round",
  "concat",
  "lower",
  "upper",
  "coalesce",
] as const;
export type CalcOp = (typeof CALC_OPS)[number];

/** Operation and aggregate objects nested in one expression; paths and literals add none. */
export const MAX_CALC_DEPTH = 8;
/** Operation and aggregate objects across all select items of one query. */
export const MAX_CALC_NODES = 100;
export const MAX_CALC_OPERANDS = 10;
export const MAX_ROUND_PLACES = 10;
export const MAX_CASE_BRANCHES = 10;
export const MAX_DATE_ADD_AMOUNT = 10_000;
export const DATE_ADD_UNITS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export type DateAddUnit = (typeof DATE_ADD_UNITS)[number];
/** `dateDiff` also counts within a day: whole hours, minutes or seconds. */
export const DATE_DIFF_UNITS = [
  "second",
  "minute",
  "hour",
  ...DATE_ADD_UNITS,
] as const;
export type DateDiffUnit = (typeof DATE_DIFF_UNITS)[number];
export const DATE_PARTS = [
  "year",
  "quarter",
  "month",
  "day",
  "weekday",
  "fiscal_year",
  "fiscal_quarter",
  "business_day",
] as const;
export type DatePart = (typeof DATE_PARTS)[number];
/** The periods a business-day count spans: the buckets but `day`. */
export const PERIOD_UNITS = [
  "week",
  "month",
  "quarter",
  "year",
  "fiscal_quarter",
  "fiscal_year",
] as const;
export type PeriodUnit = (typeof PERIOD_UNITS)[number];
/** The date operations, besides the operations of `CALC_OPS`. */
export const DATE_OPS = [
  "dateAdd",
  "dateDiff",
  "datePart",
  "businessDays",
  "businessDaysBetween",
  "businessDaysIn",
  "businessDaysInMonth",
  "businessDaysElapsed",
  "businessDaysRemaining",
  "addBusinessDays",
  "businessDaysInPeriod",
] as const;
const MAX_TEXT_LITERAL_CHARS = 1000;
const RANGE_BOUND_ERROR_TEXT =
  "A bound is { date: YYYY-MM-DD }, { timestamp: ISO 8601 } or { relative: { unit, offset, startOf? } }";

export type CalcExpr =
  | string
  | number
  | { value: string }
  | { date: string }
  | { timestamp: string }
  | RelativeDate
  | { dateAdd: [CalcExpr, number, DateAddUnit] }
  | { dateDiff: [DateDiffUnit, CalcExpr, CalcExpr] }
  | { datePart: [DatePart, CalcExpr] }
  | { businessDays: [CalcExpr, CalcExpr] }
  | { businessDaysBetween: [CalcExpr, CalcExpr] }
  | { businessDaysIn: [PeriodUnit, CalcExpr] }
  | { businessDaysInMonth: CalcExpr }
  | { businessDaysElapsed: CalcExpr | [PeriodUnit, CalcExpr] }
  | { businessDaysRemaining: CalcExpr | [PeriodUnit, CalcExpr] }
  | { addBusinessDays: [CalcExpr, CalcExpr] }
  /** In a metric's formula only. */
  | { businessDaysInPeriod: true }
  | { add: CalcExpr[] }
  | { sub: [CalcExpr, CalcExpr] }
  | { mul: CalcExpr[] }
  | { div: [CalcExpr, CalcExpr] }
  | { abs: CalcExpr }
  | { round: CalcExpr | [CalcExpr, number] }
  | { concat: CalcExpr[] }
  | { lower: CalcExpr }
  | { upper: CalcExpr }
  | { coalesce: CalcExpr[] }
  | { sum: CalcExpr }
  | { avg: CalcExpr }
  | { min: CalcExpr }
  | { max: CalcExpr }
  | { count: CalcExpr }
  | { countDistinct: CalcExpr }
  | { case: { when: { if: Filter; then: CalcExpr }[]; else?: CalcExpr } }
  | { measure: string };

const AGGREGATE_KEYS = ["sum", "avg", "min", "max", "count", "countDistinct"];

const textLiteralSchema = z.strictObject({
  value: z
    .string()
    .max(MAX_TEXT_LITERAL_CHARS)
    .refine(noNul, { error: "A text literal has no NUL" }),
});

const dateLiteralSchema = z.strictObject({
  date: z.string().refine(noNul, { error: "A date literal has no NUL" }),
});
const timestampLiteralSchema = z.strictObject({
  timestamp: z
    .string()
    .refine(noNul, { error: "A timestamp literal has no NUL" }),
});

/** The keys of the literal objects, which are expressions with no operation in them. */
const LITERAL_KEYS = ["value", "date", "timestamp", "relative"] as const;
export const isLiteralObject = (v: unknown): boolean =>
  isPlainObject(v) && LITERAL_KEYS.some((k) => k in v);

const notStar = (v: unknown) => v !== "*";

const tooDeepCalc = z.never({
  error: `Calculations nest at most ${MAX_CALC_DEPTH} levels deep`,
});
const nestedAggregate = z.never({
  error: "An aggregate does not contain another aggregate",
});

/**
 * An expression and a nested schema's issues, forwarded with their paths: a
 * union here would bury the exact path of a bad operand under invalid_union.
 */
const dispatching = <T>(
  check: (value: unknown) => z.ZodSafeParseResult<unknown> | undefined,
  description: string,
  jsonSchema: Record<string, unknown> = {}
): z.ZodType<T> =>
  z
    .unknown()
    .superRefine((value, ctx) => {
      const result = check(value);
      if (result && !result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: issue.path,
          });
        }
      }
    })
    .meta({ ...jsonSchema, description }) as unknown as z.ZodType<T>;

/**
 * An expression whose operation or aggregate object, if it is one, is at
 * `depth` (the outermost is 1); an object past the limit is refused at each key. Built out level by level like `filterAt`, so
 * parsing stops at the limit. Inside an aggregate (`aggregates` false) a
 * further aggregate is refused at its own key.
 */
const calcAt = (depth: number, aggregates: boolean): z.ZodType<CalcExpr> => {
  const deeper = depth <= MAX_CALC_DEPTH;
  const inner = deeper ? calcAt(depth + 1, aggregates) : tooDeepCalc;
  const insideAggregate = deeper ? calcAt(depth + 1, false) : tooDeepCalc;
  const many = deeper
    ? z.array(inner).min(2).max(MAX_CALC_OPERANDS).optional()
    : tooDeepCalc.optional();
  const two = deeper
    ? z.tuple([inner, inner]).optional()
    : tooDeepCalc.optional();
  const aggregate = (schema: z.ZodType) =>
    aggregates ? schema.optional() : nestedAggregate.optional();
  const round = deeper
    ? dispatching<unknown>(
        (v) =>
          Array.isArray(v)
            ? z
                .tuple([inner, z.int().min(0).max(MAX_ROUND_PLACES)])
                .safeParse(v)
            : inner.safeParse(v),
        "An expression, or [expression, places] with places an integer 0–10"
      ).optional()
    : tooDeepCalc.optional();
  /** A date, or `[unit, date]`. */
  const dateInPeriod = deeper
    ? dispatching<unknown>(
        (v) =>
          Array.isArray(v)
            ? z.tuple([z.enum(PERIOD_UNITS), inner]).safeParse(v)
            : inner.safeParse(v),
        `A date, or [unit, date] with unit one of ${PERIOD_UNITS.join(", ")}`
      ).optional()
    : tooDeepCalc.optional();

  const node = z
    .strictObject({
      add: many,
      sub: two,
      mul: many,
      div: two,
      abs: (deeper ? inner : tooDeepCalc).optional(),
      round,
      concat: many,
      lower: (deeper ? inner : tooDeepCalc).optional(),
      upper: (deeper ? inner : tooDeepCalc).optional(),
      coalesce: many,
      sum: aggregate(insideAggregate),
      avg: aggregate(insideAggregate),
      min: aggregate(insideAggregate),
      max: aggregate(insideAggregate),
      count: aggregate(insideAggregate),
      countDistinct: aggregate(
        insideAggregate.refine(notStar, {
          error: 'countDistinct takes a column or an expression, not "*"',
        })
      ),
      dateAdd: deeper
        ? z
            .tuple([
              inner,
              z.int().min(-MAX_DATE_ADD_AMOUNT).max(MAX_DATE_ADD_AMOUNT),
              z.enum(DATE_ADD_UNITS),
            ])
            .optional()
        : tooDeepCalc.optional(),
      dateDiff: deeper
        ? z.tuple([z.enum(DATE_DIFF_UNITS), inner, inner]).optional()
        : tooDeepCalc.optional(),
      datePart: deeper
        ? z.tuple([z.enum(DATE_PARTS), inner]).optional()
        : tooDeepCalc.optional(),
      businessDays: two,
      businessDaysBetween: two,
      businessDaysIn: deeper
        ? z.tuple([z.enum(PERIOD_UNITS), inner]).optional()
        : tooDeepCalc.optional(),
      businessDaysInMonth: (deeper ? inner : tooDeepCalc).optional(),
      businessDaysElapsed: dateInPeriod,
      businessDaysRemaining: dateInPeriod,
      addBusinessDays: two,
      businessDaysInPeriod: z
        .literal(true, { error: "businessDaysInPeriod is true" })
        .optional(),
      case: deeper
        ? z
            .strictObject({
              when: z
                .array(z.strictObject({ if: filterSchema, then: inner }))
                .min(1)
                .max(MAX_CASE_BRANCHES),
              else: inner.optional(),
            })
            .optional()
        : tooDeepCalc.optional(),
    })
    .superRefine((operation, ctx) => {
      if (Object.keys(operation).length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "An operation object has exactly one key",
        });
      }
    });

  return dispatching<CalcExpr>(
    (value) => {
      if (typeof value === "string") return pathSchema.safeParse(value);
      if (typeof value === "number") return z.number().safeParse(value);
      if (isPlainObject(value) && "value" in value) {
        return textLiteralSchema.safeParse(value);
      }
      if (isPlainObject(value) && "date" in value) {
        return dateLiteralSchema.safeParse(value);
      }
      if (isPlainObject(value) && "timestamp" in value) {
        return timestampLiteralSchema.safeParse(value);
      }
      if (isPlainObject(value) && "relative" in value) {
        return relativeDateSchema.safeParse(value);
      }
      // One operation. Only a fixed measure may be inside an aggregate, which
      // the planner decides, knowing which measures are fixed.
      if (isPlainObject(value) && "measure" in value) {
        return (deeper ? measureRefSchema : tooDeepCalc).safeParse(value);
      }
      return node.safeParse(value);
    },
    `A column path, a number, { value: "text" }, { date }, { timestamp }, { relative }, { measure: name }, or an object with exactly one of ${[...CALC_OPS, ...DATE_OPS, ...AGGREGATE_KEYS].join(", ")}`,
    { $ref: "#/$defs/CalcExpr" }
  );
};

/** A calculation, at the top of a select item or as an aggregate's argument. */
const calcSchema = calcAt(1, true);
/** The argument of a select-level aggregate: the aggregate itself is level 1. */
const aggregateArgSchema = calcAt(2, false);

/** A measure's formula: an expression as a calc select item holds one. */
export const measureFormulaSchema = calcSchema;
/** A measure's filter: a filter as a query's `where` holds one. */
export const measureWhereSchema = filterSchema;
/** A measure's name: the form of an `as` alias. */
export const MEASURE_NAME_SCHEMA = measureNameSchema;

/** sum, avg, min, max, count and countDistinct over an expression need a name; over a plain path they do not. */
const needsAs = (key: string) => (item: object, ctx: z.RefinementCtx) => {
  const { as, [key]: arg } = item as Record<string, unknown>;
  if (typeof arg !== "string" && as === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["as"],
      message: `A ${key} over an expression needs an "as" name`,
    });
  }
};

export type SelectItem =
  | string
  | { count: CalcExpr; as?: string }
  | { countDistinct: CalcExpr; as?: string }
  | { sum: CalcExpr; as?: string }
  | { avg: CalcExpr; as?: string }
  | { min: CalcExpr; as?: string }
  | { max: CalcExpr; as?: string }
  | { bucket: (typeof BUCKET_UNITS)[number]; column: string; as?: string }
  | { calc: CalcExpr; as: string }
  | { measure: string; as?: string };

const expressionAggregate = (
  key: "sum" | "avg" | "min" | "max" | "count" | "countDistinct"
) =>
  z
    .strictObject({
      [key]:
        key === "countDistinct"
          ? aggregateArgSchema.refine(notStar, {
              error: 'countDistinct takes a column or an expression, not "*"',
            })
          : aggregateArgSchema,
      as: aliasSchema.optional(),
    })
    .superRefine(needsAs(key));

/** The form a select item's object is checked as, by the key that names it. */
const selectForms: Record<string, z.ZodType> = {
  count: expressionAggregate("count"),
  countDistinct: expressionAggregate("countDistinct"),
  sum: expressionAggregate("sum"),
  avg: expressionAggregate("avg"),
  min: expressionAggregate("min"),
  max: expressionAggregate("max"),
  bucket: z.strictObject({
    bucket: z.enum(BUCKET_UNITS),
    column: pathSchema,
    as: aliasSchema.optional(),
  }),
  calc: z.strictObject({ calc: calcSchema, as: aliasSchema }),
  measure: z.strictObject({
    measure: measureNameSchema,
    as: aliasSchema.optional(),
  }),
};

const SELECT_ITEM_ERROR =
  'A select item is a column path or one of { count }, { countDistinct }, { sum }, { avg }, { min }, { max }, { bucket, column }, { calc: expression, as } or { measure: name }; "as" is optional except on calc';

/** Dispatched by key rather than a union, so an issue keeps its exact path. */
const selectItemSchema = dispatching<SelectItem>(
  (value) => {
    if (typeof value === "string") return pathSchema.safeParse(value);
    const form = isPlainObject(value)
      ? Object.keys(value).find((k) => k in selectForms)
      : undefined;
    return form
      ? selectForms[form]!.safeParse(value)
      : z.never({ error: SELECT_ITEM_ERROR }).safeParse(value);
  },
  SELECT_ITEM_ERROR,
  { $ref: "#/$defs/SelectItem" }
);

const operands = (min: number, max: number) => ({
  type: "array",
  items: { $ref: "#/$defs/CalcExpr" },
  minItems: min,
  maxItems: max,
});
const operation = (key: string, operand: object, description?: string) => ({
  type: "object",
  properties: { [key]: operand },
  required: [key],
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const calcRef = { $ref: "#/$defs/CalcExpr" };
const twoDates = {
  type: "array",
  prefixItems: [calcRef, calcRef],
  minItems: 2,
  maxItems: 2,
};
const unitAndDate = {
  type: "array",
  prefixItems: [{ enum: [...PERIOD_UNITS] }, calcRef],
  minItems: 2,
  maxItems: 2,
};
const DATES_IN_ZONE =
  "each date a date, a timestamp (its date in the calendar's time zone) or any date expression; null outside 1900-01-01 to 9998-12-31";
const boundJson = {
  description: RANGE_BOUND_ERROR_TEXT,
  anyOf: [
    {
      type: "object",
      properties: { date: { type: "string", format: "date" } },
      required: ["date"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { timestamp: { type: "string", format: "date-time" } },
      required: ["timestamp"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { relative: { type: "object" } },
      required: ["relative"],
      additionalProperties: false,
    },
  ],
};
/** A metric query's range, which the dispatched Zod schema cannot show. */
const METRIC_RANGE_JSON = {
  type: "object",
  description:
    "Half-open bounds on each measure's date column: gte, lt or both; relative dates in the calendar's time zone",
  properties: { gte: boundJson, lt: boundJson },
  additionalProperties: false,
};
const pathJson = { type: "string", minLength: 1 };
const asJson = { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" };

/**
 * The structured shape of expressions and select items, which the Zod
 * schemas cannot show (they dispatch by key to keep exact error paths).
 * Published by `describe()` beside the query schema; validation never reads it.
 */
const CALC_JSON_SCHEMA_DEFS = {
  CalcExpr: {
    description: `An expression nests at most ${MAX_CALC_DEPTH} levels (an aggregate counts as one); a query holds at most ${MAX_CALC_NODES} operations and aggregates`,
    anyOf: [
      { ...pathJson, description: "A column path" },
      { type: "number", description: "A number literal" },
      {
        type: "object",
        properties: {
          value: { type: "string", maxLength: MAX_TEXT_LITERAL_CHARS },
        },
        required: ["value"],
        additionalProperties: false,
        description: "A text literal; a bare string is a column path",
      },
      operation("add", operands(2, MAX_CALC_OPERANDS), "Sum of numbers"),
      operation("sub", operands(2, 2), "First minus second"),
      operation("mul", operands(2, MAX_CALC_OPERANDS), "Product of numbers"),
      operation(
        "div",
        operands(2, 2),
        "First over second; division by zero gives null; keeps at least 6 decimal places"
      ),
      operation("abs", calcRef),
      operation(
        "round",
        {
          anyOf: [
            calcRef,
            {
              type: "array",
              prefixItems: [
                calcRef,
                { type: "integer", minimum: 0, maximum: MAX_ROUND_PLACES },
              ],
              minItems: 2,
              maxItems: 2,
            },
          ],
        },
        "An expression (0 places) or [expression, places], places an integer 0 to 10; half away from zero"
      ),
      operation(
        "concat",
        operands(2, MAX_CALC_OPERANDS),
        "Text or number operands joined; null counts as empty text"
      ),
      operation("lower", calcRef),
      operation("upper", calcRef),
      {
        type: "object",
        properties: { date: { type: "string", format: "date" } },
        required: ["date"],
        additionalProperties: false,
        description: "A date literal, YYYY-MM-DD",
      },
      {
        type: "object",
        properties: { timestamp: { type: "string", format: "date-time" } },
        required: ["timestamp"],
        additionalProperties: false,
        description: "A timestamp literal, ISO 8601 with an offset or Z",
      },
      {
        type: "object",
        properties: { relative: { type: "object" } },
        required: ["relative"],
        additionalProperties: false,
        description:
          "A date relative to today in the calendar's time zone, as in where: { unit, offset, startOf? }",
      },
      operation(
        "dateAdd",
        {
          type: "array",
          prefixItems: [
            calcRef,
            {
              type: "integer",
              minimum: -MAX_DATE_ADD_AMOUNT,
              maximum: MAX_DATE_ADD_AMOUNT,
            },
            { enum: [...DATE_ADD_UNITS] },
          ],
          minItems: 3,
          maxItems: 3,
        },
        "[date or timestamp, amount, unit]: the moment shifted; a month or year step clamps to the month's last day"
      ),
      operation(
        "dateDiff",
        {
          type: "array",
          prefixItems: [{ enum: [...DATE_DIFF_UNITS] }, calcRef, calcRef],
          minItems: 3,
          maxItems: 3,
        },
        "[unit, start, end]: whole units completed from start to end, negative when end is before start"
      ),
      operation(
        "datePart",
        {
          type: "array",
          prefixItems: [{ enum: [...DATE_PARTS] }, calcRef],
          minItems: 2,
          maxItems: 2,
        },
        "[part, date or timestamp]: a number; weekday is 1 for Monday to 7 for Sunday; fiscal parts follow the calendar's fiscal year, named by the year it ends in; business_day is which business day of its month the date is (0 before the first), a timestamp read in the calendar's time zone"
      ),
      operation(
        "businessDays",
        twoDates,
        `[start, end]: the calendar's business days from start to end, both inclusive, 0 when end is before start; ${DATES_IN_ZONE}`
      ),
      operation(
        "businessDaysBetween",
        twoDates,
        `[start, end]: the business days after start through end, negative when end is before start (Monday to Tuesday is 1); ${DATES_IN_ZONE}`
      ),
      operation(
        "businessDaysIn",
        {
          type: "array",
          prefixItems: [{ enum: [...PERIOD_UNITS] }, calcRef],
          minItems: 2,
          maxItems: 2,
        },
        `[unit, date]: the business days of the period of unit holding the date (a week starts on Monday); ${DATES_IN_ZONE}`
      ),
      operation(
        "businessDaysInMonth",
        calcRef,
        `The business days of the date's month, as businessDaysIn ["month", date]; ${DATES_IN_ZONE}`
      ),
      ...(
        [
          [
            "businessDaysElapsed",
            "The business days from the first day of the date's period through the date, inclusive",
          ],
          [
            "businessDaysRemaining",
            "The business days after the date through the end of its period",
          ],
        ] as const
      ).map(([key, description]) =>
        operation(
          key,
          { anyOf: [calcRef, unitAndDate] },
          `A date (its month), or [unit, date]: ${description}; ${DATES_IN_ZONE}`
        )
      ),
      operation(
        "addBusinessDays",
        twoDates,
        `[date, n]: the date n business days after the date (before it when n is negative), n a number truncated toward zero; from a day that is not a business day, a step starts at the business day before it, and n = 0 gives the next business day; ${DATES_IN_ZONE}`
      ),
      operation(
        "businessDaysInPeriod",
        { const: true },
        "In a metric's formula only: the business days of each period of the query's bucket, or of its range (gte to lt, both needed) without one"
      ),
      operation(
        "coalesce",
        operands(2, MAX_CALC_OPERANDS),
        "The first non-null of operands of one type"
      ),
      ...(["sum", "avg", "min", "max"] as const).map((key) =>
        operation(
          key,
          calcRef,
          "Aggregate over an expression; not nested in another aggregate"
        )
      ),
      operation(
        "count",
        {
          anyOf: [pathJson, calcRef],
          description: 'A path or "*", or an expression',
        },
        "Counts the rows where the value is not null"
      ),
      operation("countDistinct", calcRef, "Counts distinct non-null values"),
      operation(
        "case",
        {
          type: "object",
          properties: {
            when: {
              type: "array",
              minItems: 1,
              maxItems: MAX_CASE_BRANCHES,
              items: {
                type: "object",
                properties: {
                  if: {
                    type: "object",
                    description:
                      "A filter over column paths, as in where; the first branch that holds gives its then",
                  },
                  then: calcRef,
                },
                required: ["if", "then"],
                additionalProperties: false,
              },
            },
            else: calcRef,
          },
          required: ["when"],
          additionalProperties: false,
        },
        "The then of the first when whose if holds, else the else (null without one); every then and the else are of one type"
      ),
      operation(
        "measure",
        asJson,
        "A measure by name: of the from table, group-level, so not inside an aggregate; or a fixed measure of any table, one value, anywhere"
      ),
    ],
  },
  SelectItem: {
    description: SELECT_ITEM_ERROR,
    anyOf: [
      { ...pathJson, description: "A column path" },
      ...(["count", "countDistinct", "sum", "avg", "min", "max"] as const).map(
        (key) => ({
          type: "object",
          properties: { [key]: calcRef, as: asJson },
          required: [key],
          additionalProperties: false,
          description: `A path, or an expression, in which case "as" is required`,
        })
      ),
      {
        type: "object",
        properties: {
          bucket: { enum: [...BUCKET_UNITS] },
          column: pathJson,
          as: asJson,
        },
        required: ["bucket", "column"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { calc: calcRef, as: asJson },
        required: ["calc", "as"],
        additionalProperties: false,
        description:
          "A calculation: row-level (no aggregate) or group-level (every column inside an aggregate), not mixed",
      },
      {
        type: "object",
        properties: { measure: asJson, as: asJson },
        required: ["measure"],
        additionalProperties: false,
        description:
          "A measure of the from table; named by its own name unless as is given",
      },
    ],
  },
};

/** Operation and aggregate objects in one expression; a measure is one. */
export const countNodes = (expr: unknown): number => {
  if (!isPlainObject(expr) || isLiteralObject(expr)) return 0;
  const [key, operand] = Object.entries(expr)[0] ?? [];
  if (key === undefined) return 0;
  if (key === "case") {
    const { when, else: otherwise } = (operand ?? {}) as {
      when?: Array<{ then?: unknown }>;
      else?: unknown;
    };
    return (
      1 +
      (Array.isArray(when) ? when : []).reduce(
        (n, branch) => n + countNodes(branch?.then),
        0
      ) +
      countNodes(otherwise)
    );
  }
  if (Array.isArray(operand)) {
    return 1 + operand.reduce<number>((n, e) => n + countNodes(e), 0);
  }
  return 1 + countNodes(operand);
};

const nodesInSelectItem = (item: unknown): number => {
  if (!isPlainObject(item)) return 0;
  if ("calc" in item) return countNodes(item.calc);
  if ("measure" in item) return 1;
  for (const key of ["sum", "avg", "min", "max", "count", "countDistinct"]) {
    if (key in item && typeof item[key] !== "string") {
      return 1 + countNodes(item[key]);
    }
  }
  return 0;
};

const joinSchema = z.union([
  pathSchema,
  z.strictObject({
    relation: pathSchema,
    type: z.enum(["inner", "left"]).optional(),
  }),
]);

const orderSchema = z
  .record(pathSchema, z.enum(["asc", "desc"]))
  .refine((o) => Object.keys(o).length === 1, {
    error: 'Each orderBy entry is one { path: "asc" | "desc" }',
  });

export const sqlQuerySchema = z
  .strictObject({
    /** The source's slug; the engine resolves it before planning. */
    source: z.string().min(1),
    from: tableNameSchema,
    join: z.array(joinSchema).max(MAX_JOINS).optional(),
    select: z.array(selectItemSchema).min(1).max(MAX_SELECT_ITEMS),
    distinct: z.boolean().optional(),
    where: filterSchema.optional(),
    groupBy: z.array(pathSchema).max(MAX_KEYS).optional(),
    having: filterSchema.optional(),
    orderBy: z.array(orderSchema).max(MAX_KEYS).optional(),
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).max(MAX_OFFSET).optional(),
  })
  .superRefine((query, ctx) => {
    let nodes = 0;
    for (const [i, item] of query.select.entries()) {
      nodes += nodesInSelectItem(item);
      if (nodes > MAX_CALC_NODES) {
        ctx.addIssue({
          code: "custom",
          path: ["select", i],
          message: `A query holds at most ${MAX_CALC_NODES} operations and aggregates in its calculations`,
        });
        break;
      }
    }
    const seen = new Set<string>();
    query.join?.forEach((join, i) => {
      const path = typeof join === "string" ? join : join.relation;
      if (seen.has(path)) {
        ctx.addIssue({
          code: "custom",
          path: ["join", i],
          message: "Each relation is joined at most once",
        });
      }
      seen.add(path);
    });
  });

export type SqlQuery = z.infer<typeof sqlQuerySchema>;
export type JoinItem = NonNullable<SqlQuery["join"]>[number];

/** Names one metric query asks for, metrics and measures together. */
export const MAX_METRIC_NAMES = 20;

/** A range's bound: a date, a timestamp or a moment relative to now. */
export type RangeBound =
  { date: string } | { timestamp: string } | RelativeDate;

const RANGE_BOUND_ERROR = RANGE_BOUND_ERROR_TEXT;

/** Dispatched by key, so an issue keeps its exact path. */
const rangeBoundSchema = dispatching<RangeBound>((value) => {
  if (isPlainObject(value) && "date" in value) {
    return dateLiteralSchema.safeParse(value);
  }
  if (isPlainObject(value) && "timestamp" in value) {
    return timestampLiteralSchema.safeParse(value);
  }
  if (isPlainObject(value) && "relative" in value) {
    return relativeDateSchema.safeParse(value);
  }
  return z.never({ error: RANGE_BOUND_ERROR }).safeParse(value);
}, RANGE_BOUND_ERROR);

/**
 * A metric query: metrics and measures by name, each measure bucketed and
 * ranged by its own date column, combined per period. Told apart from a
 * table query by its `metrics` key.
 */
export const metricQuerySchema = z
  .strictObject({
    /** The source's slug; the engine resolves it before planning. */
    source: z.string().min(1),
    metrics: z.array(measureNameSchema).min(1).max(MAX_METRIC_NAMES),
    bucket: z.enum(BUCKET_UNITS).optional(),
    range: z
      .strictObject({
        gte: rangeBoundSchema.optional(),
        lt: rangeBoundSchema.optional(),
      })
      .refine((r) => r.gte !== undefined || r.lt !== undefined, {
        error: "A range has gte, lt or both",
      })
      .optional(),
    orderBy: z
      .array(orderSchema)
      .max(MAX_METRIC_NAMES + 1)
      .optional(),
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).max(MAX_OFFSET).optional(),
  })
  .superRefine((query, ctx) => {
    const seen = new Set<string>();
    query.metrics.forEach((name, i) => {
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["metrics", i],
          message: "Each name is asked for once",
        });
      }
      seen.add(name);
    });
  });

export type MetricQuery = z.infer<typeof metricQuerySchema>;

/** Either query shape of the language. */
export type SqlLanguageQuery = SqlQuery | MetricQuery;

export const isMetricQuery = (query: SqlLanguageQuery): query is MetricQuery =>
  "metrics" in query;

/** `isMetricQuery` for a body of unknown shape: false for anything but a plain object. */
export const isMetricBody = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body) &&
  "metrics" in body;

/**
 * The language's schema: a metric query when the body has a `metrics` key,
 * else a table query. Dispatched rather than a union, so each issue keeps the
 * exact path the shape's own schema gives it.
 */
export const sqlLanguageSchema = dispatching<SqlLanguageQuery>(
  (value) =>
    isPlainObject(value) && "metrics" in value
      ? metricQuerySchema.safeParse(value)
      : sqlQuerySchema.safeParse(value),
  "A table query ({ source, from, select, ... }) or a metric query ({ source, metrics, bucket?, range?, ... })"
);

export const sqlLanguage: QueryLanguage<SqlLanguageQuery, SqlPlan> = {
  id: "sql",
  schema: sqlLanguageSchema,
  describe: () => {
    // One pass over both shapes, so their shared definitions get one name each.
    const {
      anyOf: [table, metric],
      $defs,
      ...rest
    } = z.toJSONSchema(z.union([sqlQuerySchema, metricQuerySchema]), {
      reused: "ref",
      unrepresentable: "any",
    }) as { anyOf: Record<string, unknown>[]; $defs?: object };
    return {
      ...rest,
      description:
        "A table query, or a metric query (told apart by its metrics key)",
      anyOf: [{ $ref: "#/$defs/TableQuery" }, { $ref: "#/$defs/MetricQuery" }],
      $defs: {
        ...$defs,
        ...CALC_JSON_SCHEMA_DEFS,
        TableQuery: table,
        MetricQuery: {
          ...metric,
          properties: {
            ...(metric!.properties as Record<string, unknown>),
            range: METRIC_RANGE_JSON,
          },
        },
      },
    };
  },
  plan: (query, catalog, ctx) =>
    isMetricQuery(query)
      ? planMetrics(query, catalog, ctx)
      : planSql(query, catalog, ctx),
  tableName: queryNameOf,
};
