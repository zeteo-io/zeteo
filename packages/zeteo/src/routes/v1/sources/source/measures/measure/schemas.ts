import { IdSchema } from "../../../../../../utils/idSchema.js";
import { MeasureFieldsShape } from "../schemas.js";
import { z } from "zod";

export const MeasureParamsSchema = z.object({
  sourceId: IdSchema,
  measureId: IdSchema,
});

/** Any of a measure's fields; `where: null` removes its filter, `date_column: null` its date column. */
export const UpdateMeasureSchema = z
  .strictObject({
    name: MeasureFieldsShape.name.optional(),
    description: MeasureFieldsShape.description.optional(),
    table: MeasureFieldsShape.table.optional(),
    formula: MeasureFieldsShape.formula.optional(),
    where: MeasureFieldsShape.where.optional(),
    fixed: MeasureFieldsShape.fixed.optional(),
    date_column: MeasureFieldsShape.date_column.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give at least one field to change",
  });
