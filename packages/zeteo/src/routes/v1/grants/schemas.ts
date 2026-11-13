import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

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

const CreateShape = {
  principal_type: PrincipalTypeSchema,
  principal_id: IdSchema,
  table_id: IdSchema,
};

export const CreateGrantSchema = z.discriminatedUnion("all_columns", [
  z.strictObject({ ...CreateShape, ...GrantColumnsShape.all }),
  z.strictObject({ ...CreateShape, ...GrantColumnsShape.list }),
]);

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
