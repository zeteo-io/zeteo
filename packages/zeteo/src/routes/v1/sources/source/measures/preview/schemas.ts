import { BUCKET_UNITS } from "../../../../../../adapters/sql/language.js";
import { noNul } from "../../../../../../utils/text.js";
import { CreateMeasureSchema } from "../schemas.js";
import { z } from "zod";

/** A draft measure, not saved, and the optional bucket its value is grouped by. */
export const PreviewMeasureSchema = z.strictObject({
  measure: CreateMeasureSchema,
  bucket: z
    .strictObject({
      unit: z.enum(BUCKET_UNITS),
      column: noNul(z.string().min(1).max(256)),
    })
    .optional(),
});
