import { checkRows, GrantColumnsShape, GrantRowsShape } from "../schemas.js";
import { RowAccessSchema } from "../../../../row-rules/schema.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const GrantParamsSchema = z.object({ grantId: IdSchema });

/**
 * The whole of a grant's columns and rows: the principal and table are fixed.
 * `row_access` is required, so a body of columns only cannot drop a rule.
 */
const ReplaceRowsShape = { ...GrantRowsShape, row_access: RowAccessSchema };

export const ReplaceGrantSchema = z
  .discriminatedUnion("all_columns", [
    z.strictObject({ ...GrantColumnsShape.all, ...ReplaceRowsShape }),
    z.strictObject({ ...GrantColumnsShape.list, ...ReplaceRowsShape }),
  ])
  .superRefine(checkRows);
