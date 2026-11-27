import { IdSchema } from "../../../../../utils/idSchema.js";
import { noNul } from "../../../../../utils/text.js";
import { z } from "zod";

export const MAX_VALUES_PER_CALL = 1000;

export const ListIdentityValuesQuerySchema = z.strictObject({
  user_id: IdSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const IdentityValueCursorSchema = z.tuple([IdSchema]);

/** A value is exact text of 1 to 500 characters; nothing is trimmed or folded. */
export const IdentityValueTextSchema = noNul(z.string().min(1).max(500));

export const AddIdentityValuesSchema = z.strictObject({
  values: z
    .array(
      z.strictObject({
        user_id: z.uuid().transform((s) => s.toLowerCase()),
        value: IdentityValueTextSchema,
      })
    )
    .min(1)
    .max(MAX_VALUES_PER_CALL),
});
