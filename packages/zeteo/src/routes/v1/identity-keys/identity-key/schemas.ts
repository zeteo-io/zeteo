import { KeyDescriptionSchema, KeyLabelSchema } from "../schemas.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const IdentityKeyParamsSchema = z.object({ keyId: IdSchema });

/** The name never changes; null clears the description. */
export const UpdateIdentityKeySchema = z
  .strictObject({
    label: KeyLabelSchema.optional(),
    description: KeyDescriptionSchema.nullable().optional(),
  })
  .refine((b) => b.label !== undefined || b.description !== undefined, {
    message: "Give label, description or both",
  });
