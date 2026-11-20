import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

/** Whose access to which table; `organization_id` counts that organization's groups too (absent: global groups only). */
export const EffectiveAccessQuerySchema = z.strictObject({
  user_id: IdSchema,
  table_id: IdSchema,
  organization_id: IdSchema.optional(),
});
