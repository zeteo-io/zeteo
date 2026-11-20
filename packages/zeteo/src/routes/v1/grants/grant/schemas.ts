import { checkRows, GrantColumnsShape, GrantRowsShape } from "../schemas.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const GrantParamsSchema = z.object({ grantId: IdSchema });

/** The whole of a grant's columns and rows (`row_access` defaults as on a create): the principal and table are fixed. */
export const ReplaceGrantSchema = z
  .discriminatedUnion("all_columns", [
    z.strictObject({ ...GrantColumnsShape.all, ...GrantRowsShape }),
    z.strictObject({ ...GrantColumnsShape.list, ...GrantRowsShape }),
  ])
  .superRefine(checkRows);
