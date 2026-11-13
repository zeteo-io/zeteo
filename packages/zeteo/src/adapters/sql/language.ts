import type { QueryLanguage } from "../types.js";
import type { SqlPlan } from "./types.js";
import { planSql } from "./plan.js";
import { z } from "zod";

// The SQL-shaped JSON query language shared by every SQL source. Every object
// is strict; there are no expressions, only the closed sets below.

export const MAX_SELECT_ITEMS = 50;
export const MAX_JOINS = 4;
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

export const BUCKET_UNITS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;

const selectItemSchema = z.union(
  [
    pathSchema,
    z.strictObject({ count: pathSchema, as: aliasSchema.optional() }),
    z.strictObject({ countDistinct: pathSchema, as: aliasSchema.optional() }),
    z.strictObject({ sum: pathSchema, as: aliasSchema.optional() }),
    z.strictObject({ avg: pathSchema, as: aliasSchema.optional() }),
    z.strictObject({ min: pathSchema, as: aliasSchema.optional() }),
    z.strictObject({ max: pathSchema, as: aliasSchema.optional() }),
    z.strictObject({
      bucket: z.enum(BUCKET_UNITS),
      column: pathSchema,
      as: aliasSchema.optional(),
    }),
  ],
  {
    error:
      'A select item is a column path, or one of { count: path | "*" }, { countDistinct }, { sum }, { avg }, { min }, { max } or { bucket, column }, each with an optional "as"',
  }
);

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
    z.strictObject({ eq: scalarSchema }),
    z.strictObject({ ne: scalarSchema }),
    z.strictObject({ gt: scalarSchema }),
    z.strictObject({ gte: scalarSchema }),
    z.strictObject({ lt: scalarSchema }),
    z.strictObject({ lte: scalarSchema }),
    z.strictObject({ between: z.tuple([scalarSchema, scalarSchema]) }),
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
export type Condition =
  | { eq: Scalar }
  | { ne: Scalar }
  | { gt: Scalar }
  | { gte: Scalar }
  | { lt: Scalar }
  | { lte: Scalar }
  | { between: [Scalar, Scalar] }
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
export type SelectItem = SqlQuery["select"][number];
export type JoinItem = NonNullable<SqlQuery["join"]>[number];

export const sqlLanguage: QueryLanguage<SqlQuery, SqlPlan> = {
  id: "sql",
  schema: sqlQuerySchema,
  describe: () =>
    z.toJSONSchema(sqlQuerySchema, { reused: "ref", unrepresentable: "any" }),
  plan: planSql,
};
