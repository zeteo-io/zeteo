import { CreateMetricSchema } from "../schemas.js";
import { z } from "zod";
import {
  BUCKET_UNITS,
  metricQuerySchema,
} from "../../../../../../adapters/sql/language.js";

/** A draft metric, not saved, and the optional bucket and range of the metric query it is previewed in. */
export const PreviewMetricSchema = z.strictObject({
  metric: CreateMetricSchema,
  bucket: z.enum(BUCKET_UNITS).optional(),
  range: metricQuerySchema.shape.range,
});
