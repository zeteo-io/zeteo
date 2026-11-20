import { IDENTITY_KEY_NAME } from "../../../row-rules/schema.js";
import { noNul } from "../../../utils/text.js";
import { z } from "zod";

export const KeyNameSchema = z.string().regex(IDENTITY_KEY_NAME, {
  error:
    "An identity key name is a lowercase letter then up to 63 of a-z, 0-9 and _",
});
export const KeyLabelSchema = noNul(z.string().min(1).max(100));
export const KeyDescriptionSchema = noNul(z.string().max(500));

export const CreateIdentityKeySchema = z.strictObject({
  name: KeyNameSchema,
  label: KeyLabelSchema,
  description: KeyDescriptionSchema.optional(),
});
