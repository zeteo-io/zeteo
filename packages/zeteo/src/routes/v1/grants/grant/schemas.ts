import { IdSchema } from "../../../../utils/idSchema.js";
import { GrantColumnsShape } from "../schemas.js";
import { z } from "zod";

export const GrantParamsSchema = z.object({ grantId: IdSchema });

/** Only the columns half of a grant: the principal and table are fixed. */
export const ReplaceGrantSchema = z.discriminatedUnion("all_columns", [
  z.strictObject(GrantColumnsShape.all),
  z.strictObject(GrantColumnsShape.list),
]);
