import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

export const IdentityValueParamsSchema = z.object({
  keyId: IdSchema,
  valueId: IdSchema,
});
