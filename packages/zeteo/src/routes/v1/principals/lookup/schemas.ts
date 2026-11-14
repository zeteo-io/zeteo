import { PrincipalTypeSchema } from "../../grants/schemas.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const LookupPrincipalsBodySchema = z.strictObject({
  principals: z
    .array(z.strictObject({ type: PrincipalTypeSchema, id: IdSchema }))
    .min(1)
    .max(100),
});
