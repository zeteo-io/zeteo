import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

/** `?member=<id>&member=<id>`: the tables to merge, two or more. */
export const MergedColumnsQuerySchema = z.object({
  member: z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(IdSchema).min(2).max(100)
  ),
});
