import { IdSchema } from "../../../../../../utils/idSchema.js";
import { MetricFieldsShape } from "../schemas.js";
import { z } from "zod";

export const MetricParamsSchema = z.object({
  sourceId: IdSchema,
  metricId: IdSchema,
});

/** Any of a metric's fields. */
export const UpdateMetricSchema = z
  .strictObject({
    name: MetricFieldsShape.name.optional(),
    description: MetricFieldsShape.description.optional(),
    formula: MetricFieldsShape.formula.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give at least one field to change",
  });
