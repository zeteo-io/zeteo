import { relativeDateSchema, type RelativeDate } from "./relative.js";
import type { QueryLanguage } from "../types.js";
import { planSql, queryNameOf } from "./plan.js";
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

/** A value a comparison takes: a literal, or a moment relative to now. */
const comparedSchema = z.union([scalarSchema, relativeDateSchema]);

export const BUCKET_UNITS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
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
const MAX_TEXT_LITERAL_CHARS = 1000;

export type CalcExpr =
  | string
  | number
  | { value: string }
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
  | { count: string }
  | { countDistinct: string };

const AGGREGATE_KEYS = ["sum", "avg", "min", "max", "count", "countDistinct"];

const textLiteralSchema = z.strictObject({
  value: z
    .string()
    .max(MAX_TEXT_LITERAL_CHARS)
    .refine(noNul, { error: "A text literal has no NUL" }),
});

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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
      count: aggregate(pathSchema),
      countDistinct: aggregate(
        pathSchema.refine((p) => p !== "*", {
          error: 'countDistinct takes a column path, not "*"',
        })
      ),
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
      return node.safeParse(value);
    },
    `A column path, a number, { value: "text" }, or an object with exactly one of ${[...CALC_OPS, ...AGGREGATE_KEYS].join(", ")}`,
    { $ref: "#/$defs/CalcExpr" }
  );
};

/** A calculation, at the top of a select item or as an aggregate's argument. */
const calcSchema = calcAt(1, true);
/** The argument of a select-level aggregate: the aggregate itself is level 1. */
const aggregateArgSchema = calcAt(2, false);

/** sum, avg, min and max over an expression need a name; over a plain path they do not. */
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
  | { count: string; as?: string }
  | { countDistinct: string; as?: string }
  | { sum: CalcExpr; as?: string }
  | { avg: CalcExpr; as?: string }
  | { min: CalcExpr; as?: string }
  | { max: CalcExpr; as?: string }
  | { bucket: (typeof BUCKET_UNITS)[number]; column: string; as?: string }
  | { calc: CalcExpr; as: string };

const expressionAggregate = (key: "sum" | "avg" | "min" | "max") =>
  z
    .strictObject({ [key]: aggregateArgSchema, as: aliasSchema.optional() })
    .superRefine(needsAs(key));

/** The form a select item's object is checked as, by the key that names it. */
const selectForms: Record<string, z.ZodType> = {
  count: z.strictObject({ count: pathSchema, as: aliasSchema.optional() }),
  countDistinct: z.strictObject({
    countDistinct: pathSchema,
    as: aliasSchema.optional(),
  }),
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
};

const SELECT_ITEM_ERROR =
  'A select item is a column path or one of { count }, { countDistinct }, { sum }, { avg }, { min }, { max }, { bucket, column } or { calc: expression, as }; "as" is optional except on calc';

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
      operation("count", { ...pathJson, description: 'A path or "*"' }),
      operation("countDistinct", pathJson),
    ],
  },
  SelectItem: {
    description: SELECT_ITEM_ERROR,
    anyOf: [
      { ...pathJson, description: "A column path" },
      ...(["count", "countDistinct"] as const).map((key) => ({
        type: "object",
        properties: { [key]: pathJson, as: asJson },
        required: [key],
        additionalProperties: false,
      })),
      ...(["sum", "avg", "min", "max"] as const).map((key) => ({
        type: "object",
        properties: { [key]: calcRef, as: asJson },
        required: [key],
        additionalProperties: false,
        description: `A path, or an expression, in which case "as" is required`,
      })),
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
    ],
  },
};

/** Operation and aggregate objects in one expression. */
const countNodes = (expr: unknown): number => {
  if (!isPlainObject(expr) || "value" in expr) return 0;
  const [key, operand] = Object.entries(expr)[0] ?? [];
  if (key === undefined) return 0;
  if (Array.isArray(operand)) {
    return 1 + operand.reduce<number>((n, e) => n + countNodes(e), 0);
  }
  return 1 + countNodes(operand);
};

const nodesInSelectItem = (item: unknown): number => {
  if (!isPlainObject(item)) return 0;
  if ("calc" in item) return countNodes(item.calc);
  for (const key of ["sum", "avg", "min", "max"]) {
    if (key in item && typeof item[key] !== "string") {
      return 1 + countNodes(item[key]);
    }
  }
  return 0;
};

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
] as const;
export type Operator = (typeof OPERATORS)[number];

const valuesSchema = z.array(scalarSchema).min(1).max(MAX_IN_VALUES);

/** Exactly one operator and its value. */
const conditionSchema = z.union(
  [
    z.strictObject({ eq: comparedSchema }),
    z.strictObject({ ne: comparedSchema }),
    z.strictObject({ gt: comparedSchema }),
    z.strictObject({ gte: comparedSchema }),
    z.strictObject({ lt: comparedSchema }),
    z.strictObject({ lte: comparedSchema }),
    z.strictObject({ between: z.tuple([comparedSchema, comparedSchema]) }),
    z.strictObject({ in: valuesSchema }),
    z.strictObject({ notIn: valuesSchema }),
    z.strictObject({ contains: z.string().refine(noNul) }),
    z.strictObject({ startsWith: z.string().refine(noNul) }),
    z.strictObject({ isNull: z.boolean() }),
  ],
  {
    error: `Each path takes exactly one operator: ${OPERATORS.join(", ")}`,
  }
);

/** Keys that are always logical operators, never column paths. */
const LOGICAL_KEYS = new Set(["and", "or", "not"]);

export type Scalar = string | number | boolean;
export type Compared = Scalar | RelativeDate;
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
  | { isNull: boolean };
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
const filterAt = (depth: number): z.ZodType<Filter> => {
  const inner = depth < MAX_FILTER_DEPTH ? filterAt(depth + 1) : undefined;
  const node = z
    .object({
      and: (inner ? z.array(inner).min(1) : tooDeep).optional(),
      or: (inner ? z.array(inner).min(1) : tooDeep).optional(),
      not: (inner ?? tooDeep).optional(),
    })
    .catchall(conditionSchema)
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
    })
    .meta({
      description:
        "One of { and: [filter] }, { or: [filter] }, { not: filter }, or { path: { operator: value }, ... } where several paths must all hold",
    });
  return node as unknown as z.ZodType<Filter>;
};

const filterSchema = filterAt(1);

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

export const sqlLanguage: QueryLanguage<SqlQuery, SqlPlan> = {
  id: "sql",
  schema: sqlQuerySchema,
  describe: () => {
    const schema = z.toJSONSchema(sqlQuerySchema, {
      reused: "ref",
      unrepresentable: "any",
    });
    return { ...schema, $defs: { ...schema.$defs, ...CALC_JSON_SCHEMA_DEFS } };
  },
  plan: planSql,
  tableName: queryNameOf,
};
