import { IdSchema } from "../../../../../utils/idSchema.js";
import { TimeRangeSchema } from "../../schemas.js";
import { z } from "zod";

export const RunDashboardSchema = z.strictObject({
  panels: z
    .array(IdSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Name each panel once",
    })
    .optional(),
  time_range: TimeRangeSchema.nullable().optional(),
});
