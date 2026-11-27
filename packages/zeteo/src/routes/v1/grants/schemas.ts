import type { GrantAccess } from "../../../grants/service.js";
import type { RuleFilter } from "../../../row-rules/types.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { noNul } from "../../../utils/text.js";
import { z } from "zod";
import {
  RowAccessSchema,
  RowRuleInputSchema,
} from "../../../row-rules/schema.js";

export const PrincipalTypeSchema = z.enum(["user", "group"]);

/** 1 to 500 distinct column ids. */
const ColumnIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "column_ids must be distinct",
  });

/** The columns a grant covers: all of them, or a list. A create adds the principal and table to either. */
export const GrantColumnsShape = {
  all: { all_columns: z.literal(true) },
  list: { all_columns: z.literal(false), column_ids: ColumnIdsSchema },
};

/**
 * A grant's rows: `row_access`, and with `rule` (only) its `row_rule` and
 * optional `row_rule_description`. A null rule, and a null or blank
 * description, are taken as not given.
 */
export const GrantRowsShape = {
  row_access: RowAccessSchema.default("unlimited_default"),
  row_rule: RowRuleInputSchema.nullish().transform((v) => v ?? undefined),
  row_rule_description: noNul(z.string().trim().max(200))
    .nullish()
    .transform((v) => (v ? v : undefined)),
};

type RowsBody = {
  row_access: z.infer<typeof RowAccessSchema>;
  row_rule?: unknown;
  row_rule_description?: string;
};

/** `row_rule` is given exactly when `row_access` is `rule`, and a description only with a rule. */
export const checkRows = (body: RowsBody, ctx: z.RefinementCtx) => {
  const rule = body.row_access === "rule";
  if (rule && body.row_rule === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["row_rule"],
      message: 'row_rule is required when row_access is "rule"',
    });
  }
  if (!rule && body.row_rule !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["row_rule"],
      message: 'row_rule is only for row_access "rule"',
    });
  }
  if (!rule && body.row_rule_description !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["row_rule_description"],
      message: 'row_rule_description is only for row_access "rule"',
    });
  }
};

/** The service's columns and rows from a checked create or replace body. */
export const accessOf = (
  body: RowsBody &
    ({ all_columns: true } | { all_columns: false; column_ids: string[] })
): GrantAccess => ({
  columns: body.all_columns
    ? { allColumns: true }
    : { allColumns: false, columnIds: body.column_ids },
  rows:
    body.row_access === "rule"
      ? {
          access: "rule",
          rule: body.row_rule as RuleFilter,
          description: body.row_rule_description,
        }
      : { access: body.row_access },
});

const CreateShape = {
  principal_type: PrincipalTypeSchema,
  principal_id: IdSchema,
  table_id: IdSchema,
};

export const CreateGrantSchema = z
  .discriminatedUnion("all_columns", [
    z.strictObject({
      ...CreateShape,
      ...GrantColumnsShape.all,
      ...GrantRowsShape,
    }),
    z.strictObject({
      ...CreateShape,
      ...GrantColumnsShape.list,
      ...GrantRowsShape,
    }),
  ])
  .superRefine(checkRows);

export const ListGrantsQuerySchema = z.strictObject({
  principal_type: PrincipalTypeSchema.optional(),
  principal_id: IdSchema.optional(),
  table_id: IdSchema.optional(),
  source_id: IdSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: the grant's id (ids are time-ordered). */
export const GrantCursorSchema = z.tuple([IdSchema]);
